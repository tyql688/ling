import type { ProjectMentionCache } from "./project-mention-cache";
import {
	type OpenProjectInfo,
	type ProjectRemovalOutcome,
	type WorkspaceMeta,
	PROJECT_LIST_FAILURE_MESSAGE_MAX_CHARS,
	type ProjectListFailure,
} from "@ling/contracts/project";
import type { PiDiagnostic } from "@ling/contracts/pi-diagnostic";
import { type SessionRef, sessionKey } from "@ling/contracts/session-ref";
import { toCommandError } from "@ling/core/command-resolver";
import { createLingError } from "@ling/core/ling-error";
import { listWorktrees, removeWorktree as removeGitWorktree } from "@ling/host/domains/git/git-mutations";
import { getGitStatus } from "@ling/host/domains/git/git-service";
import { createLogger } from "@ling/core/logger";
import { pathIdentity } from "@ling/core/paths";
import { type MetadataCleanupHost, metadataCleanupWarning } from "@ling/host/domains/projects/metadata-cleanup";
import type { ProjectStore } from "./project-store";
import type { PiWorkerClient } from "@ling/host/workers/pi/pi-worker-client";
import { realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, sep } from "node:path";
import { findKnownWorkspaceRoot } from "./workspace-paths";

const log = createLogger("project-lifecycle");

async function directoryExists(cwd: string): Promise<boolean> {
	try {
		return (await stat(cwd)).isDirectory();
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return false;
		throw toCommandError(error);
	}
}

interface ProjectStoreRecovery {
	assertWritable(): void;
	clear(): void;
	clearWriteError(): void;
	getIssue(): ProjectStoreIssue | null;
	recordReadError(error: unknown): void;
	recordWriteError(error: unknown): void;
}

type ProjectStoreIssue = { kind: "read" | "write"; error: Error };

function createProjectStoreRecovery(): ProjectStoreRecovery {
	let issue: ProjectStoreIssue | null = null;
	return {
		assertWritable() {
			if (issue?.kind === "read") throw new Error("Project store is unavailable");
		},
		clear() {
			issue = null;
		},
		clearWriteError() {
			if (issue?.kind === "write") issue = null;
		},
		getIssue() {
			return issue;
		},
		recordReadError(error) {
			issue = { kind: "read", error: toCommandError(error) };
		},
		recordWriteError(error) {
			issue = { kind: "write", error: toCommandError(error) };
		},
	};
}

export interface RemoveProjectOptions {
	/** Runs after managed sessions close but before irreversible external cleanup (for example, Git worktree removal). */
	afterRuntimeClose?: (project: { cwd: string }) => Promise<void> | void;
	/** Runs only after the closed-project store state commits and runtime teardown succeeds. */
	afterPersist?: () => Promise<void>;
}

interface ProjectSessionLifecycle {
	closeSessionsForProject(
		cwd: string,
		onSessionsClosing?: (refs: readonly SessionRef[]) => void,
	): Promise<SessionRef[]>;
	cancelProjectSessionOperations(cwd: string, reason: string): void;
	cancelAllSessionOperations(reason: string): void;
	unsubscribeSessionEvents(refs: readonly SessionRef[]): Promise<void>;
	restoreSessionRuntimesAndEvents(refs: readonly SessionRef[]): Promise<void>;
}

interface ProjectLifecycleOptions {
	projectStore: ProjectStore;
	mentionCache: ProjectMentionCache;
	runBoundedGitWriteAtRoot<Result>(
		canonicalRoot: string,
		operation: (signal: AbortSignal) => Promise<Result>,
	): Promise<Result>;
	metadataCleanup: MetadataCleanupHost;
	piWorker: Pick<
		PiWorkerClient,
		"listOpenProjectPaths" | "withProject" | "inspectProject" | "openProject" | "closeProject" | "prepareShutdown"
	>;
	sessions: ProjectSessionLifecycle;
}

/** Owns project admission, durable mutation ordering and rollback for one Host lifetime. */
export function createProjectLifecycle({
	projectStore,
	piWorker,
	sessions,
	mentionCache,
	runBoundedGitWriteAtRoot,
	metadataCleanup,
}: ProjectLifecycleOptions) {
	const { closeSessionsForProject } = sessions;
	const { readOpenProjectPaths, writeOpenProjectPaths, readOpenProjectPathsBackup } = projectStore;
	const { clearMentionFilesCache, deleteMentionFilesCache } = mentionCache;

	const { coordinateMetadataCleanup } = metadataCleanup;
	const recovery = createProjectStoreRecovery();
	const restorationFailures = new Map<string, Error>();

	function projectRestorationFailures(): ProjectListFailure[] {
		return [...restorationFailures].map(([cwd, error]) => ({
			cwd,
			message: error.message.slice(0, PROJECT_LIST_FAILURE_MESSAGE_MAX_CHARS),
		}));
	}

	async function workspaceMeta(cwd: string): Promise<WorkspaceMeta> {
		const status = await getGitStatus(cwd);
		if (!status.isRepository) return { kind: "primary", branchName: null };
		const canonicalPath = await realpath(cwd);
		const worktrees = await listWorktrees(cwd);
		const current = worktrees.find((worktree) => worktree.canonicalPath === canonicalPath);
		if (!current) return { kind: "primary", branchName: status.currentBranch };
		if (current.primary) return { kind: "primary", branchName: current.branchName };
		const primary = worktrees.find((worktree) => worktree.primary);
		return {
			kind: "worktree",
			rootWorkspacePath: primary ? primary.canonicalPath : canonicalPath,
			branchName: current.branchName,
		};
	}

	/** Global resources (user skills, packages, extra paths) reach every project through the same
	 * loader, so their diagnostics would otherwise flag every project at once. The project badge
	 * only carries what lives under this project and still needs attention — informational
	 * notes such as a skill shadowing another stay out of it. */
	function isProjectDiagnostic(diagnostic: PiDiagnostic, cwd: string): boolean {
		if (diagnostic.severity === "info") return false;
		if (diagnostic.path === undefined) return true;
		const rel = relative(cwd, diagnostic.path);
		return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
	}

	async function toProjectInfo(cwd: string): Promise<OpenProjectInfo> {
		return piWorker.withProject(cwd, async (canonicalCwd) => {
			const { diagnostics } = await piWorker.inspectProject(canonicalCwd);
			const ready = await directoryExists(canonicalCwd);
			// Missing directories remain manageable projects; Git metadata cannot be inspected until they return.
			const meta: WorkspaceMeta = ready ? await workspaceMeta(canonicalCwd) : { kind: "primary", branchName: null };
			// basename() is separator-aware on every platform; `split("/").pop()` returned the
			// whole path as the name on Windows (backslash paths don't split on `/`).
			return {
				cwd: canonicalCwd,
				name: basename(canonicalCwd) || canonicalCwd,
				availability: ready ? "ready" : "missing",
				meta,
				diagnostics: diagnostics.filter((diagnostic) => isProjectDiagnostic(diagnostic, canonicalCwd)),
			};
		});
	}

	/** Restores every project that was open last time. Each path is independent — one missing/deleted
	 * directory logs and is skipped rather than blocking the rest. Never falls back to `process.cwd()`. */
	async function restoreOpenProjects(): Promise<void> {
		recovery.clear();
		let paths: string[];
		try {
			paths = readOpenProjectPaths();
		} catch (error) {
			recovery.recordReadError(error);
			log.error("failed to read persisted open projects:", error);
			return;
		}
		restorationFailures.clear();
		await reopenStoredProjects(paths);
		// An interrupted or partial restore must not replace the durable list with a prefix.
		if (!acceptingProjectMutations || restorationFailures.size > 0) return;
		try {
			await persistOpenProjects();
		} catch (error) {
			// Keep complete runtimes usable while exposing that their set is not durable yet.
			recovery.recordWriteError(error);
			log.error("failed to persist restored projects:", error);
		}
	}

	async function reopenStoredProjects(paths: readonly string[]): Promise<void> {
		for (const path of paths) {
			// Quit can begin while the startup restore owns the project mutation queue.
			// Stop before opening another project; the shutdown mutation queued behind this
			// restore will close anything that already completed.
			if (!acceptingProjectMutations) return;
			try {
				await realpath(path);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
					restorationFailures.set(path, toCommandError(error));
					log.error(`could not resolve persisted project ${path}; retaining it for recovery:`, error);
					continue;
				}
				// A deleted folder still restores: the project reports `availability: "missing"` and
				// keeps its sessions listed. Dropping it here would lose that history silently.
				log.warn(`restoring project whose directory no longer exists: ${path}`);
			}
			try {
				await piWorker.openProject(path);
				restorationFailures.delete(path);
			} catch (error) {
				restorationFailures.set(path, toCommandError(error));
				log.error(`failed to restore project ${path}:`, error);
			}
		}
	}

	/** Explicit corrupt-store recovery retains every backup path, including failed reopenings,
	 * in the same owner used by subsequent Add/Remove writes and visible recovery state. */
	async function recoverOpenProjectsFromBackup(): Promise<void> {
		const paths = readOpenProjectPathsBackup();
		if (paths !== null) await reopenStoredProjects(paths);
		if (!acceptingProjectMutations) throw new Error("Project recovery was interrupted by shutdown");
		await projectStore.recoverOpenProjectPaths([
			...new Set([...piWorker.listOpenProjectPaths(), ...restorationFailures.keys()]),
		]);
	}

	function persistOpenProjects(): Promise<void> {
		return writeOpenProjectPaths([...new Set([...piWorker.listOpenProjectPaths(), ...restorationFailures.keys()])]);
	}

	let projectMutationQueue: Promise<void> = Promise.resolve();
	let acceptingProjectMutations = true;
	let projectShutdownPromise: Promise<void> | null = null;

	/** Project lifecycle mutations and their single persisted store share one transaction queue.
	 * Without this, a failed Add rollback can overwrite a concurrently committed Remove (or vice versa). */
	function enqueueProjectMutation<T>(operation: () => Promise<T>): Promise<T> {
		const result = projectMutationQueue.then(operation, operation);
		projectMutationQueue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	function runProjectMutation<T>(operation: () => Promise<T>): Promise<T> {
		if (!acceptingProjectMutations) return Promise.reject(new Error("Project lifecycle is shutting down"));
		return enqueueProjectMutation(operation);
	}

	interface ProjectRuntimeTeardown {
		canonicalCwd: string;
		sessionRefs: Map<string, SessionRef>;
	}

	function captureSessionRefs(teardown: ProjectRuntimeTeardown, refs: readonly SessionRef[]): void {
		for (const ref of refs) teardown.sessionRefs.set(sessionKey(ref), ref);
	}

	async function closeProjectAndSessions(
		cwd: string,
		teardown: ProjectRuntimeTeardown = { canonicalCwd: cwd, sessionRefs: new Map() },
	): Promise<ProjectRuntimeTeardown> {
		await piWorker.closeProject(cwd, async (closingCwd) => {
			teardown.canonicalCwd = closingCwd;
			// Abort in-flight transcript/autocomplete/diff ops before disposing runtimes.
			sessions.cancelProjectSessionOperations(closingCwd, "projectClosing");
			const closedSessionRefs = await closeSessionsForProject(closingCwd, (refs) => captureSessionRefs(teardown, refs));
			captureSessionRefs(teardown, closedSessionRefs);
			await sessions.unsubscribeSessionEvents([...teardown.sessionRefs.values()]);
		});
		deleteMentionFilesCache(teardown.canonicalCwd);
		return teardown;
	}

	function closeAllProjectsForShutdown(): Promise<void> {
		if (projectShutdownPromise) return projectShutdownPromise;
		prepareShutdown();
		projectShutdownPromise = (async () => {
			const errors: Error[] = [];
			try {
				await piWorker.prepareShutdown();
			} catch (error) {
				errors.push(toCommandError(error));
			}
			try {
				await enqueueProjectMutation(async () => {
					for (const cwd of [...piWorker.listOpenProjectPaths()]) {
						try {
							await closeProjectAndSessions(cwd);
						} catch (error) {
							errors.push(toCommandError(error));
						}
					}
					clearMentionFilesCache();
				});
			} catch (error) {
				errors.push(toCommandError(error));
			}
			if (errors.length > 0) throw new AggregateError(errors, "Failed to close every open project during shutdown");
		})();
		return projectShutdownPromise;
	}

	async function captureRollbackFailure(errors: Error[], operation: () => Promise<unknown>): Promise<void> {
		try {
			await operation();
		} catch (error) {
			errors.push(toCommandError(error));
		}
	}

	function rethrowWithRollbackFailures(error: unknown, rollbackErrors: Error[], message: string): never {
		const operationError = toCommandError(error);
		if (rollbackErrors.length > 0) throw new AggregateError([operationError, ...rollbackErrors], message);
		throw operationError;
	}

	async function openProjectAndPersistNow(projectPath: string): Promise<OpenProjectInfo> {
		// Restoring a deleted project is deliberate; adding one is not. Only the restore path may
		// admit a missing folder, so a mistyped request cannot register a project that never existed.
		if (!(await directoryExists(projectPath))) {
			throw createLingError({
				code: "PROJECT_DIRECTORY_MISSING",
				category: "validation",
				message: `The project directory no longer exists: ${projectPath}`,
				retryable: false,
				details: { cwd: projectPath },
			});
		}
		// Validate the durable store before opening anything. The writer publishes without reading,
		// so this gate prevents a project transaction from overwriting corrupt data.
		readOpenProjectPaths();
		const openBefore = new Set(piWorker.listOpenProjectPaths());
		const project = await piWorker.openProject(projectPath);
		const openedByThisTransaction = !openBefore.has(project.cwd);
		const recovered = [...restorationFailures].filter(
			([path]) => pathIdentity(path) === pathIdentity(projectPath) || pathIdentity(path) === pathIdentity(project.cwd),
		);

		let info: OpenProjectInfo;
		try {
			// Build every fallible response field before the store commit so success has
			// no post-commit operation that could make the renderer observe a false failure.
			info = await toProjectInfo(project.cwd);
		} catch (error) {
			if (!openedByThisTransaction) throw toCommandError(error);
			const rollbackErrors: Error[] = [];
			await captureRollbackFailure(rollbackErrors, () => closeProjectAndSessions(project.cwd));
			rethrowWithRollbackFailures(error, rollbackErrors, `Failed to inspect ${project.cwd} and close the new project`);
		}

		try {
			for (const [path] of recovered) restorationFailures.delete(path);
			await persistOpenProjects();
		} catch (error) {
			for (const [path, failure] of recovered) restorationFailures.set(path, failure);
			const rollbackErrors: Error[] = [];
			if (openedByThisTransaction) {
				await captureRollbackFailure(rollbackErrors, () => closeProjectAndSessions(project.cwd));
			}
			rethrowWithRollbackFailures(error, rollbackErrors, `Failed to persist ${project.cwd} and roll back the Add`);
		}
		return info;
	}

	function openProjectAndPersist(projectPath: string): Promise<OpenProjectInfo> {
		return runProjectMutation(async () => {
			recovery.assertWritable();
			const info = await openProjectAndPersistNow(projectPath);
			recovery.clearWriteError();
			return info;
		});
	}

	async function canonicalOpenProjectPath(cwd: string): Promise<string> {
		return piWorker.withProject(cwd, async (canonicalCwd) => canonicalCwd);
	}

	function pathsAfterProjectRemoval(canonicalCwd: string): string[] {
		const openPaths = piWorker.listOpenProjectPaths();
		const remaining = openPaths.filter((path) => path !== canonicalCwd);
		if (remaining.length === openPaths.length) throw new Error(`Unknown open project: ${canonicalCwd}`);
		return [...new Set([...remaining, ...restorationFailures.keys()])];
	}

	async function restoreProjectRuntime(teardown: ProjectRuntimeTeardown): Promise<void> {
		await piWorker.openProject(teardown.canonicalCwd);
		await sessions.restoreSessionRuntimesAndEvents([...teardown.sessionRefs.values()]);
	}

	async function tryRestoreRemovedProject(
		teardown: ProjectRuntimeTeardown,
		persistedBefore: readonly string[],
	): Promise<{ restored: boolean; errors: Error[] }> {
		const errors: Error[] = [];
		try {
			await restoreProjectRuntime(teardown);
		} catch (error) {
			errors.push(toCommandError(error));
			return { restored: false, errors };
		}
		try {
			await writeOpenProjectPaths([...persistedBefore]);
			return { restored: true, errors };
		} catch (error) {
			errors.push(toCommandError(error));
			return { restored: false, errors };
		}
	}

	async function recommitProjectRemoval(
		teardown: ProjectRuntimeTeardown,
		persistedAfter: readonly string[],
		errors: Error[],
	): Promise<void> {
		if (piWorker.listOpenProjectPaths().includes(teardown.canonicalCwd)) {
			await captureRollbackFailure(errors, () => closeProjectAndSessions(teardown.canonicalCwd));
		}
		await captureRollbackFailure(errors, () => writeOpenProjectPaths([...persistedAfter]));
	}

	function removedWithWarning(
		canonicalCwd: string,
		operationError: unknown,
		rollbackErrors: readonly Error[],
	): ProjectRemovalOutcome {
		const details = [toCommandError(operationError), ...rollbackErrors].map((error) => error.message).join("; ");
		const warning = `Removed ${canonicalCwd}, but cleanup reported: ${details}`;
		log.error(warning);
		return { status: "removed-with-warning", cwd: canonicalCwd, warning };
	}

	async function removeProjectAndPersistNow(
		cwd: string,
		options: RemoveProjectOptions,
	): Promise<ProjectRemovalOutcome> {
		const persistedBefore = [...readOpenProjectPaths()];
		const canonicalCwd = await canonicalOpenProjectPath(cwd);
		const persistedAfter = pathsAfterProjectRemoval(canonicalCwd);

		// Durable removal intent commits before any runtime is destroyed. The database transaction
		// retains the previous durable membership on failure, so no compensating rewrite is needed.
		await writeOpenProjectPaths(persistedAfter);

		const teardown: ProjectRuntimeTeardown = { canonicalCwd, sessionRefs: new Map() };
		try {
			// closeProjectAndSessions cancels session + change-review ops for the project.
			await closeProjectAndSessions(canonicalCwd, teardown);
			await options.afterRuntimeClose?.({ cwd: canonicalCwd });
		} catch (error) {
			const rollback = await tryRestoreRemovedProject(teardown, persistedBefore);
			if (rollback.restored) throw toCommandError(error);
			await recommitProjectRemoval(teardown, persistedAfter, rollback.errors);
			return removedWithWarning(canonicalCwd, error, rollback.errors);
		}

		if (options.afterPersist) {
			try {
				await options.afterPersist();
			} catch (error) {
				const rollback = await tryRestoreRemovedProject(teardown, persistedBefore);
				if (rollback.restored) throw toCommandError(error);
				await recommitProjectRemoval(teardown, persistedAfter, rollback.errors);
				return removedWithWarning(canonicalCwd, error, rollback.errors);
			}
		}

		const cleanup = await coordinateMetadataCleanup({
			type: "projectRemoved",
			project: { cwd: canonicalCwd },
			sessionRefs: [...teardown.sessionRefs.values()],
			occurredAt: Date.now(),
		});
		const cleanupWarning = metadataCleanupWarning(cleanup);
		if (cleanupWarning !== null) {
			log.error(cleanupWarning);
			return { status: "removed-with-warning", cwd: canonicalCwd, warning: cleanupWarning };
		}

		return { status: "removed", cwd: canonicalCwd };
	}

	function removeProjectAndPersist(cwd: string, options: RemoveProjectOptions = {}): Promise<ProjectRemovalOutcome> {
		return runProjectMutation(async () => {
			recovery.assertWritable();
			const outcome = await removeProjectAndPersistNow(cwd, options);
			recovery.clearWriteError();
			return outcome;
		});
	}

	/** Keeps this Host's mutation queue ahead of the root Project lease. Acquiring
	 * these in the opposite order can deadlock with a concurrent primary-project
	 * Remove that holds the queue while waiting for the same lease to drain. */
	function removeWorktreeProjectAndPersist(
		rootCwd: string,
		worktreePath: string,
		options: Pick<RemoveProjectOptions, "afterRuntimeClose"> = {},
	): Promise<ProjectRemovalOutcome> {
		return runProjectMutation(() => {
			const canonicalRoot = findKnownWorkspaceRoot(rootCwd, piWorker.listOpenProjectPaths());
			if (canonicalRoot === null) throw new Error(`Unknown workspace: ${rootCwd}`);
			return piWorker.withProject(canonicalRoot, async (canonicalRootCwd) => {
				recovery.assertWritable();
				const targetPath = await realpath(worktreePath);
				const worktrees = await listWorktrees(canonicalRootCwd);
				const target = worktrees.find((worktree) => worktree.canonicalPath === targetPath);
				if (!target) throw new Error(`Unknown worktree: ${worktreePath}`);
				if (target.primary) throw new Error("Cannot remove the primary worktree");
				const gitRoot = worktrees.find((worktree) => worktree.primary)?.canonicalPath ?? canonicalRootCwd;
				const outcome = await removeProjectAndPersistNow(target.canonicalPath, {
					...options,
					afterPersist: () =>
						runBoundedGitWriteAtRoot(gitRoot, (signal) => removeGitWorktree(canonicalRootCwd, target.path, signal)),
				});
				recovery.clearWriteError();
				return outcome;
			});
		});
	}

	function prepareShutdown(): void {
		if (!acceptingProjectMutations) return;
		acceptingProjectMutations = false;
		// Cancellation must precede waiting on a mutation whose project lease can still need input.
		sessions.cancelAllSessionOperations("appShutdown");
	}

	return {
		recovery,
		projectRestorationFailures,
		toProjectInfo,
		restoreOpenProjects,
		recoverOpenProjectsFromBackup,
		persistOpenProjects,
		runProjectMutation,
		openProjectAndPersist,
		removeProjectAndPersist,
		removeWorktreeProjectAndPersist,
		prepareShutdown,
		closeAllProjectsForShutdown,
	};
}

export type ProjectLifecycle = ReturnType<typeof createProjectLifecycle>;
