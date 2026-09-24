import type { ExtensionUiBridge } from "@ling/core/pi-protocol/extension-ui";
import { createSessionLifecycleOperations } from "./session-lifecycle-operations";
import { createSessionLifecycleEvents } from "./session-lifecycle-events";
import { createSessionRegistry } from "./session-registry";
import { createSessionRuntimeCommands } from "./session-runtime-commands";
import type { BeforeBindSession, SessionRuntimeProvider } from "@ling/core/pi-protocol/runtime-provider";
import type { SessionTranscriptProjectionCache } from "../transcript-projection-cache-port";
import {
	type SessionRef,
	type PiResourceReloadMode,
	type SessionResourceReloadSummary,
	type SessionSummary,
	type ThinkingLevel,
	SESSION_RESOURCE_RELOAD_FAILURE_MAX_CHARS,
	SESSION_RESOURCE_RELOAD_MAX_FAILURES,
} from "@ling/contracts/session";
import { sessionKey, toSessionRef } from "@ling/contracts/session-ref";
import { errorCode } from "@ling/contracts/ling-error";
import { createLingError, throwAggregateFailures, toError } from "@ling/core/ling-error";
import { createLogger } from "@ling/core/logger";
import { pathIdentity } from "@ling/core/paths";
import { access, rm, unlink } from "node:fs/promises";
import { deriveForkSessionTitle, normalizeLingSessionTitle } from "./session-input";
import type { ManagedSession } from "./session-managed-state";
import { attachSessionRelations } from "./session-relations";
import type { SessionRuntimePort } from "@ling/core/pi-protocol/runtime-port";
import {
	hasListedSessionName,
	type ListedSessionSummary,
	projectListedSessionSummary,
	projectListedSessionTitle,
	projectSessionSummaryText,
} from "./session-summary";

const log = createLogger("session-manager");

type ManagedSessionsStateDependencies = {
	runtimeProvider: SessionRuntimeProvider;
	projectionCache: SessionTranscriptProjectionCache;
	extensionUi: ExtensionUiBridge;
};

interface ManagedSessionsState extends ManagedSessionsStateDependencies {
	lifecycleOperations: ReturnType<typeof createSessionLifecycleOperations>;
	lifecycleEvents: ReturnType<typeof createSessionLifecycleEvents>;
	registry: ReturnType<typeof createSessionRegistry>;
	commands: ReturnType<typeof createSessionRuntimeCommands>;
	stopping: boolean;
	disposal: Promise<void> | null;
	resourceRevision: number;
}

export function createManagedSessionManager({
	runtimeProvider,
	projectionCache,
	extensionUi,
}: ManagedSessionsStateDependencies) {
	const lifecycleOperations = createSessionLifecycleOperations();
	const lifecycleEvents = createSessionLifecycleEvents();
	const registry = createSessionRegistry({ runtimeProvider, extensionUi, lifecycleEvents, lifecycleOperations });
	const commands = createSessionRuntimeCommands({ registry, extensionUi, projectionCache });
	const owner: ManagedSessionsState = {
		runtimeProvider,
		projectionCache,
		extensionUi,
		lifecycleOperations,
		lifecycleEvents,
		registry,
		commands,
		stopping: false,
		disposal: null,
		resourceRevision: 0,
	};
	return {
		reloadSessionResources(
			projectCwds?: readonly string[],
			mode: PiResourceReloadMode = "full",
		): Promise<SessionResourceReloadSummary> {
			return reloadSessionResources(owner, projectCwds, mode);
		},
		createSession(
			cwd: string,
			title = "New session",
			options: {
				beforeBind?: BeforeBindSession;
				model?: { provider: string; id: string };
				thinkingLevel?: ThinkingLevel;
			} = {},
		): Promise<SessionSummary> {
			return createSession(owner, cwd, title, options);
		},
		listAllSessions(
			projectCwds: string[],
			cachedSessions: readonly ListedSessionSummary[] = [],
		): Promise<ListedSessionSummary[]> {
			return listAllSessions(owner, projectCwds, cachedSessions);
		},
		resumeSession(ref: SessionRef, options: { beforeBind?: BeforeBindSession } = {}): Promise<void> {
			return resumeSession(owner, ref, options);
		},
		suspendSessionIfIdle(
			ref: SessionRef,
			beforeSuspend: (ref: SessionRef) => boolean,
			afterSuspend: (ref: SessionRef) => void,
		): Promise<boolean> {
			return suspendSessionIfIdle(owner, ref, beforeSuspend, afterSuspend);
		},
		closeSessionsForProject(
			cwd: string,
			onSessionsClosing?: (refs: readonly SessionRef[]) => void,
		): Promise<SessionRef[]> {
			return closeSessionsForProject(owner, cwd, onSessionsClosing);
		},
		deleteSession(ref: SessionRef): Promise<void> {
			return deleteSession(owner, ref);
		},
		forkSession(
			ref: SessionRef,
			entryId: string,
			options: { beforeBind?: BeforeBindSession } = {},
		): Promise<SessionSummary> {
			return forkSession(owner, ref, entryId, options);
		},
		registry: owner.registry,
		commands: owner.commands,
		lifecycleEvents: owner.lifecycleEvents,
		prepareShutdown(): void {
			return prepareShutdown(owner);
		},
		dispose(): Promise<void> {
			return dispose(owner);
		},
	};
}

/**
 * Runtime constructed but never entered managedSessions. Dispose the handle, drop
 * dialog requesters registered by beforeBind, and optionally remove a brand-new
 * session file so create/fork attach failures do not leave ghosts in the catalog.
 */
async function disposeUnattachedRuntime(
	owner: ManagedSessionsState,
	session: SessionRuntimePort,
	options: { deleteSessionFile: boolean },
): Promise<void> {
	const ref = session.ref;
	const sessionFile = options.deleteSessionFile ? session.sessionFile : undefined;
	try {
		await session.dispose();
	} finally {
		owner.extensionUi.unregisterApprovalRequester(ref);
		owner.extensionUi.unregisterExtensionUiRequester(ref);
		owner.extensionUi.clearExtensionUiState(ref);
		if (sessionFile) {
			await rm(sessionFile, { force: true }).catch((cleanupError: unknown) => {
				log.error(`failed to remove unattached session file ${sessionFile}:`, cleanupError);
			});
		}
	}
}

/**
 * Applies one resource revision to the selected projects' live sessions. Idle sessions finish before this
 * resolves; busy sessions retain the revision and reload after their current run ends.
 */
async function reloadSessionResources(
	owner: ManagedSessionsState,
	projectCwds: readonly string[] | undefined,
	mode: PiResourceReloadMode,
): Promise<SessionResourceReloadSummary> {
	if (projectCwds?.length === 0)
		return { revision: owner.resourceRevision, reloaded: 0, deferred: 0, failed: [], failedOmitted: 0 };
	owner.resourceRevision += 1;
	const revision = owner.resourceRevision;
	// A runtime whose construction started before the mutation may attach after the
	// first snapshot. Let current opens settle so they are either included or fail;
	// opens started after this point already read the mutated canonical files.
	await Promise.allSettled(owner.lifecycleOperations.pendingSessionRuntimeCreations());
	const selected = projectCwds === undefined ? null : new Set(projectCwds);
	const targets = owner.registry.listManagedSessions().filter((managed) => !selected || selected.has(managed.ref.cwd));
	for (const managed of targets) {
		managed.resourceReload.requestRevision(revision, mode);
	}

	const attempts = await Promise.allSettled(targets.map((managed) => managed.resourceReload.reconcile(revision)));
	const summary: SessionResourceReloadSummary = {
		revision,
		reloaded: 0,
		deferred: 0,
		failed: [],
		failedOmitted: 0,
	};
	for (const [index, managed] of targets.entries()) {
		const attempt = attempts[index];
		if (attempt?.status === "rejected") {
			if (summary.failed.length >= SESSION_RESOURCE_RELOAD_MAX_FAILURES) {
				summary.failedOmitted += 1;
			} else {
				const message = toError(attempt.reason).message;
				summary.failed.push({
					ref: { ...managed.ref },
					message: projectSessionSummaryText(message, SESSION_RESOURCE_RELOAD_FAILURE_MAX_CHARS),
				});
			}
			continue;
		}
		// A concurrent explicit close may retire a successfully drained target.
		// A rejected fail-closed reload, however, was recorded above even though its
		// lifecycle listener already removed the managed session from this map.
		if (!owner.registry.isManagedSessionCurrent(managed)) continue;
		if (managed.resourceReload.hasApplied(revision)) {
			summary.reloaded += 1;
		} else {
			summary.deferred += 1;
		}
	}
	return summary;
}

function createSession(
	owner: ManagedSessionsState,
	cwd: string,
	title = "New session",
	options: {
		beforeBind?: BeforeBindSession;
		model?: { provider: string; id: string };
		thinkingLevel?: ThinkingLevel;
	} = {},
): Promise<SessionSummary> {
	assertRunning(owner);
	let canonicalCwd: string;
	try {
		canonicalCwd = owner.runtimeProvider.resolveProject(cwd);
	} catch (error) {
		return Promise.reject(error);
	}
	const resourceRevisionAtCreation = owner.resourceRevision;
	return owner.lifecycleOperations.trackProjectSessionOperation(
		canonicalCwd,
		owner.lifecycleOperations.trackSessionRuntimeCreation(
			createSessionNow(owner, canonicalCwd, title, options, resourceRevisionAtCreation),
		),
	);
}

async function createSessionNow(
	owner: ManagedSessionsState,
	cwd: string,
	title: string,
	options: {
		beforeBind?: BeforeBindSession;
		model?: { provider: string; id: string };
		thinkingLevel?: ThinkingLevel;
	},
	resourceRevisionAtCreation: number,
): Promise<SessionSummary> {
	const normalizedTitle = normalizeLingSessionTitle(title);
	const now = Date.now();
	// The default title is deliberately NOT persisted — an empty stored name is how later code
	// (resume backfill below, session summaries) tells "still auto-titleable" apart from a name the
	// user chose. The returned summary still carries it for immediate display in the sidebar.

	const session = await owner.runtimeProvider.create(cwd, options);
	try {
		owner.registry.attachManagedSession(session.ref, session, session.cwd, {
			autoTitle: true,
			createdAt: now,
			placeholderTitle: normalizedTitle,
			resourceRevisionAtCreation,
			latestResourceRevision: owner.resourceRevision,
		});
	} catch (error) {
		await disposeUnattachedRuntime(owner, session, { deleteSessionFile: true });
		throw error;
	}
	log.info(`created session ${session.sessionId} in ${session.cwd}`);

	return {
		id: session.sessionId,
		cwd: session.cwd,
		title: normalizedTitle,
		createdAt: now,
		updatedAt: now,
		messageCount: 0,
		preview: "",
	};
}

async function listSessionsForProject(
	owner: ManagedSessionsState,
	cwd: string,
	cachedSessions: readonly ListedSessionSummary[],
): Promise<ListedSessionSummary[]> {
	const canonicalCwd = owner.runtimeProvider.resolveProject(cwd);
	const cachedByPath = new Map(
		cachedSessions
			.filter((summary) => summary.cwd === canonicalCwd && summary.sourceFingerprint !== undefined)
			.map((summary) => [pathIdentity(summary.sessionFilePath), summary]),
	);
	const discovered = await owner.runtimeProvider.discoverSessions(
		canonicalCwd,
		[...cachedByPath.values()].flatMap((summary) =>
			summary.sourceFingerprint ? [{ path: summary.sessionFilePath, fingerprint: summary.sourceFingerprint }] : [],
		),
	);
	return discovered.flatMap((entry) => {
		if (entry.kind === "loaded") {
			return [projectListedSessionSummary(canonicalCwd, entry.info, entry.fingerprint ?? undefined)];
		}
		const cached = cachedByPath.get(pathIdentity(entry.path));
		return cached ? [cached] : [];
	});
}

/** Sessions across every currently open project — the renderer groups these by `cwd` itself. */
async function listAllSessions(
	owner: ManagedSessionsState,
	projectCwds: string[],
	cachedSessions: readonly ListedSessionSummary[] = [],
): Promise<ListedSessionSummary[]> {
	assertRunning(owner);
	const perProject = await Promise.all(projectCwds.map((cwd) => listSessionsForProject(owner, cwd, cachedSessions)));
	const summaries = perProject.flat();
	const projectSet = new Set(projectCwds);
	const listedKeys = new Set(summaries.map((summary) => sessionKey(toSessionRef(summary))));
	for (const managed of owner.registry.listManagedSessions()) {
		if (!projectSet.has(managed.cwd)) continue;
		const key = sessionKey(managed.ref);
		if (listedKeys.has(key)) continue;
		summaries.push(owner.registry.summarizeManagedSession(managed));
		listedKeys.add(key);
	}
	return attachSessionRelations(summaries);
}

function resumeSession(
	owner: ManagedSessionsState,
	ref: SessionRef,
	options: { beforeBind?: BeforeBindSession } = {},
): Promise<void> {
	assertRunning(owner);
	let canonicalCwd: string;
	try {
		canonicalCwd = owner.runtimeProvider.resolveProject(ref.cwd);
	} catch (error) {
		return Promise.reject(error);
	}
	const canonicalRef = { cwd: canonicalCwd, sessionId: ref.sessionId };
	const deleting = owner.lifecycleOperations.getDeletingSession(canonicalRef);
	if (deleting) return deleting.then(() => resumeSession(owner, canonicalRef, options));
	const closing = owner.lifecycleOperations.getClosingSession(canonicalRef);
	if (closing) return closing.then(() => resumeSession(owner, canonicalRef, options));
	const existing = owner.registry.findManagedSession(canonicalRef);
	if (existing) {
		owner.registry.touchManagedSession(existing);
		return Promise.resolve();
	}
	const opening = owner.lifecycleOperations.getOpeningSession(canonicalRef);
	if (opening) return opening;

	const resourceRevisionAtCreation = owner.resourceRevision;
	return owner.lifecycleOperations.registerOpeningSession(
		canonicalRef,
		owner.lifecycleOperations.trackProjectSessionOperation(
			canonicalCwd,
			owner.lifecycleOperations.trackSessionRuntimeCreation(
				resumeSessionNow(owner, canonicalRef, options, resourceRevisionAtCreation),
			),
		),
	);
}

async function resumeSessionNow(
	owner: ManagedSessionsState,
	canonicalRef: SessionRef,
	options: { beforeBind?: BeforeBindSession },
	resourceRevisionAtCreation: number,
): Promise<void> {
	const canonicalCwd = owner.runtimeProvider.resolveProject(canonicalRef.cwd);
	const infos = await owner.runtimeProvider.listSessions(canonicalCwd);
	const info = infos.find((entry) => entry.id === canonicalRef.sessionId);
	if (!info) {
		throw createLingError({
			code: "SESSION_NOT_FOUND",
			category: "lifecycle",
			message: `Unknown session: ${canonicalRef.sessionId}`,
			retryable: false,
			userAction: "reopenProject",
			details: { sessionId: canonicalRef.sessionId },
		});
	}
	const path = info.path;
	const createdAt = info.createdAt;
	const name = info.name;
	const firstMessage = info.firstMessage;
	const messageCount = info.messageCount;
	const hasName = hasListedSessionName(name);
	const session = await owner.runtimeProvider.resume(canonicalCwd, path, createdAt, options);
	if (sessionKey(session.ref) !== sessionKey(canonicalRef)) {
		// The runtime never enters managedSessions, so dispose its beforeBind requesters
		// through the same fail-closed path as any other unattached resume.
		await disposeUnattachedRuntime(owner, session, { deleteSessionFile: false });
		throw createLingError({
			code: "SESSION_LIFECYCLE_CONFLICT",
			category: "lifecycle",
			message: "The discovered session file identity changed before it could be opened.",
			retryable: false,
			userAction: "report",
			details: {
				expectedSessionId: canonicalRef.sessionId,
				actualSessionId: session.ref.sessionId,
			},
		});
	}
	// A resumed session with messages but no stored name missed its auto-title (generation
	// failed, or the app quit before the first turn ended) — backfill it now instead of
	// leaving it default-titled forever.
	let managed: ManagedSession;
	try {
		managed = owner.registry.attachManagedSession(session.ref, session, canonicalCwd, {
			autoTitle: !hasName,
			createdAt,
			placeholderTitle: projectListedSessionTitle(name, firstMessage),
			resourceRevisionAtCreation,
			latestResourceRevision: owner.resourceRevision,
		});
	} catch (error) {
		// Resume never deletes history on disk — only drop requesters + dispose handle.
		await disposeUnattachedRuntime(owner, session, { deleteSessionFile: false });
		throw error;
	}
	if (!hasName && messageCount > 0) {
		owner.registry.startManagedSessionAutoTitle(managed);
	}
}

function closeSession(owner: ManagedSessionsState, ref: SessionRef): Promise<void> {
	const activeClose = owner.lifecycleOperations.getClosingSession(ref);
	if (activeClose) return activeClose;

	return owner.lifecycleOperations.registerClosingSession(
		ref,
		owner.lifecycleOperations.trackProjectSessionOperation(
			ref.cwd,
			(async () => {
				const opening = owner.lifecycleOperations.getOpeningSession(ref);
				if (opening) {
					try {
						await opening;
					} catch {
						return;
					}
				}
				const managed = owner.registry.findManagedSession(ref);
				if (!managed) return;
				await owner.registry.disposeManagedSession(managed);
			})(),
		),
	);
}

/** Releases a historical runtime only when it is still genuinely idle at the disposal boundary.
 * `beforeSuspend` lets the host atomically detach bridges and reject candidates with pending UI.
 * `afterSuspend` runs after core teardown (also when teardown reports an error after its fail-closed
 * finally), so the host can publish a final ordered retirement boundary. */
async function suspendSessionIfIdle(
	owner: ManagedSessionsState,
	ref: SessionRef,
	beforeSuspend: (ref: SessionRef) => boolean,
	afterSuspend: (ref: SessionRef) => void,
): Promise<boolean> {
	assertRunning(owner);
	const canonicalCwd = owner.runtimeProvider.resolveProject(ref.cwd);
	const canonicalRef = { cwd: canonicalCwd, sessionId: ref.sessionId };
	const activeClose = owner.lifecycleOperations.getClosingSession(canonicalRef);
	if (activeClose) {
		await activeClose;
		return false;
	}

	let suspended = false;
	const operation = Promise.resolve().then(async () => {
		const opening = owner.lifecycleOperations.getOpeningSession(canonicalRef);
		if (opening) {
			try {
				await opening;
			} catch {
				return;
			}
		}
		const managed = owner.registry.findManagedSession(canonicalRef);
		if (!managed || !owner.registry.isManagedSessionRetirable(managed)) return;
		// Pi defers the first file write until an assistant message arrives. Dropping that
		// runtime would erase its unsaved entries and leave no session to resume or unarchive.
		const sessionFile = managed.session.sessionFile;
		if (!sessionFile) return;
		try {
			await access(sessionFile);
		} catch (error) {
			if (errorCode(error) === "ENOENT") return;
			throw error;
		}
		if (!owner.registry.isManagedSessionRetirable(managed) || managed.session.sessionFile !== sessionFile) return;
		if (!beforeSuspend(managed.ref)) return;
		suspended = true;
		const suspendedRef = { ...managed.ref };
		let disposeFailure: unknown = null;
		try {
			await owner.registry.disposeManagedSession(managed);
		} catch (error) {
			disposeFailure = error;
		}
		let hostFailure: unknown = null;
		try {
			afterSuspend(suspendedRef);
		} catch (error) {
			hostFailure = error;
		}
		throwAggregateFailures(
			[disposeFailure, hostFailure].filter((failure) => failure !== null),
			"Session runtime teardown and host settlement failed",
		);
	});
	await owner.lifecycleOperations.registerClosingSession(
		canonicalRef,
		owner.lifecycleOperations.trackProjectSessionOperation(canonicalCwd, operation),
	);
	return suspended;
}

/** Disposes only the sessions belonging to one project (e.g. before closing that project). Returns
 * the closed session ids so callers (e.g. session-ipc.ts) can also tear down their own per-session
 * IPC forwarding, which isn't something session-manager.ts knows about. */
async function closeSessionsForProject(
	owner: ManagedSessionsState,
	cwd: string,
	onSessionsClosing?: (refs: readonly SessionRef[]) => void,
): Promise<SessionRef[]> {
	const closedRefs = new Map<string, SessionRef>();
	while (true) {
		const opening = owner.lifecycleOperations.pendingProjectSessionOperations(cwd);
		if (opening.length > 0) await Promise.allSettled(opening);

		const refsToClose: SessionRef[] = [];
		const managedToClose = owner.registry.listManagedSessionsForProject(cwd);
		for (const managed of managedToClose) {
			refsToClose.push(managed.ref);
			closedRefs.set(sessionKey(managed.ref), managed.ref);
		}
		if (refsToClose.length > 0) {
			onSessionsClosing?.(refsToClose);
			await Promise.all(refsToClose.map((ref) => closeSession(owner, ref)));
			// Dispose may finish an in-flight replace; capture the final identity so
			// IPC bridge teardown covers nextRef as well as the pre-close ref.
			for (const managed of managedToClose) {
				closedRefs.set(sessionKey(managed.ref), managed.ref);
				closedRefs.set(sessionKey(managed.session.ref), managed.session.ref);
			}
		}

		const hasOpening = owner.lifecycleOperations.hasProjectSessionOperations(cwd);
		const hasManaged = owner.registry.listManagedSessionsForProject(cwd).length > 0;
		if (!hasOpening && !hasManaged) {
			owner.registry.clearSessionRegistryProject(cwd);
			return [...closedRefs.values()];
		}
	}
}

/** Stops managing the session (if open) and deletes its underlying file — there is no SDK-level
 * delete method since this is a plain filesystem concern, not an agent-runtime one. */
function deleteSession(owner: ManagedSessionsState, ref: SessionRef): Promise<void> {
	assertRunning(owner);
	let canonicalCwd: string;
	try {
		canonicalCwd = owner.runtimeProvider.resolveProject(ref.cwd);
	} catch (error) {
		return Promise.reject(error);
	}
	const canonicalRef = { cwd: canonicalCwd, sessionId: ref.sessionId };
	const activeDelete = owner.lifecycleOperations.getDeletingSession(canonicalRef);
	if (activeDelete) return activeDelete;

	return owner.lifecycleOperations.registerDeletingSession(
		canonicalRef,
		owner.lifecycleOperations.trackProjectSessionOperation(
			canonicalCwd,
			(async () => {
				await closeSession(owner, canonicalRef);
				const infos = await owner.runtimeProvider.listSessions(canonicalCwd);
				const info = infos.find((entry) => entry.id === canonicalRef.sessionId);
				if (info) {
					await unlink(info.path).catch((error: NodeJS.ErrnoException) => {
						if (error.code !== "ENOENT") throw error;
					});
				}
				await owner.projectionCache.delete(canonicalRef);
				owner.registry.clearSessionRegistryIdentity(canonicalRef);
			})(),
		),
	);
}

/**
 * Creates a new session containing only the conversation path from root up to `entryId` (see
 * `SessionManager.createBranchedSession`), and starts managing it. The original session is
 * untouched and keeps running independently.
 */
function forkSession(
	owner: ManagedSessionsState,
	ref: SessionRef,
	entryId: string,
	options: { beforeBind?: BeforeBindSession } = {},
): Promise<SessionSummary> {
	assertRunning(owner);
	const managed = owner.registry.requireManagedSession(ref);
	const resourceRevisionAtCreation = owner.resourceRevision;
	return owner.lifecycleOperations.trackProjectSessionOperation(
		managed.cwd,
		owner.lifecycleOperations.trackSessionRuntimeCreation(
			forkSessionNow(owner, ref, entryId, options, managed, resourceRevisionAtCreation),
		),
	);
}

async function forkSessionNow(
	owner: ManagedSessionsState,
	ref: SessionRef,
	entryId: string,
	options: { beforeBind?: BeforeBindSession },
	managed: ManagedSession,
	resourceRevisionAtCreation: number,
): Promise<SessionSummary> {
	const { session, cwd } = managed;
	const title = deriveForkSessionTitle(session.getSessionName());
	const newSession = await owner.runtimeProvider.fork(session, entryId, title, options);
	const now = Date.now();
	try {
		owner.registry.attachManagedSession(newSession.ref, newSession, cwd, {
			createdAt: now,
			placeholderTitle: title,
			resourceRevisionAtCreation,
			latestResourceRevision: owner.resourceRevision,
		});
	} catch (error) {
		await disposeUnattachedRuntime(owner, newSession, { deleteSessionFile: true });
		throw error;
	}
	log.info(`forked session ${ref.sessionId} -> ${newSession.sessionId}`);

	return {
		id: newSession.sessionId,
		cwd,
		title,
		createdAt: now,
		updatedAt: now,
		messageCount: newSession.summarize(now, title).messageCount,
		preview: "",
	};
}

function assertRunning(owner: ManagedSessionsState): void {
	if (owner.stopping)
		throw createLingError({
			code: "REQUEST_CANCELLED",
			category: "lifecycle",
			message: "Session manager is shutting down.",
			retryable: false,
		});
}

function prepareShutdown(owner: ManagedSessionsState): void {
	owner.stopping = true;
}

function dispose(owner: ManagedSessionsState): Promise<void> {
	if (owner.disposal) return owner.disposal;
	owner.stopping = true;
	const completion = Promise.withResolvers<void>();
	owner.disposal = completion.promise;
	void (async () => {
		const failures: unknown[] = [];
		try {
			await owner.lifecycleOperations.drain();
		} catch (error) {
			failures.push(error);
		}
		const projects = new Set(owner.registry.listManagedSessions().map((managed) => managed.cwd));
		const results = await Promise.allSettled([...projects].map((cwd) => closeSessionsForProject(owner, cwd)));
		for (const result of results) if (result.status === "rejected") failures.push(result.reason);
		try {
			await owner.lifecycleOperations.drain();
		} catch (error) {
			failures.push(error);
		}
		owner.lifecycleEvents.dispose();
		if (failures.length > 0) throw new AggregateError(failures, "Failed to dispose managed sessions");
	})().then(completion.resolve, completion.reject);
	return owner.disposal;
}

export type ManagedSessionManager = ReturnType<typeof createManagedSessionManager>;
