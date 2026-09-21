import type {
	ChangeReviewScope,
	CommitChangeReviewRequest,
	DiscardChangeReviewRequest,
	GitCommitResult,
	GitStatus,
	RevertChangeReviewTurnRequest,
} from "@ling/contracts/git";
import type { SessionRef } from "@ling/contracts/session";
import { findReviewFileByLineage, type ReviewChangeFile } from "@ling/core/change-review/change-review";
import { commitPaths, discardPaths } from "@ling/host/domains/git/git-mutations";
import type { GitWriteQueue } from "../git/git-write-queue";
import { changeReviewWorkspaceFingerprint } from "./change-review-query";
import { restoreTurnPatch, reverseApplyTurnPatch } from "./change-review-revert";
import type { ChangeReviewRuntimeOwner } from "./change-review-runtime";
import type { ChangeReviewRuntimeState } from "./change-review-state";
import type { ChangeReviewStore } from "./change-review-store";

type ChangeReviewWriteAction = "commit" | "discard";

interface ChangeReviewMutationOwner {
	commit(request: CommitChangeReviewRequest): Promise<GitCommitResult>;
	revertTurn(request: RevertChangeReviewTurnRequest): Promise<void>;
	discard(request: DiscardChangeReviewRequest): Promise<GitStatus>;
}

function rejectStaleWriteSnapshot(state: ChangeReviewRuntimeState, action: ChangeReviewWriteAction): never {
	state.computed = undefined;
	const verb = action === "commit" ? "committing" : "discarding";
	throw new Error(`The change review snapshot is stale; refresh it before ${verb} changes`);
}

function assertSafeWriteScope(action: ChangeReviewWriteAction, scope: ChangeReviewScope): void {
	if (scope === "mixed" || scope === "external" || scope === "committed" || scope === "unpushed") {
		throw new Error(`Cannot ${action} ${scope} changes automatically`);
	}
}

function assertSafeWriteFile(action: ChangeReviewWriteAction, file: ReviewChangeFile): void {
	if (file.owner === "mixed") {
		throw new Error("Mixed files need manual review before changing them");
	}
	if (file.owner === "external") {
		throw new Error("External files need manual review before changing them");
	}
	if (file.status === "clean") {
		throw new Error(`Clean files cannot be ${action === "commit" ? "committed" : "discarded"}`);
	}
	if (file.status === "conflicted") {
		throw new Error("Conflicted files need manual resolution before changing them");
	}
}

function pathsForFiles(files: readonly ReviewChangeFile[]): string[] {
	return files.flatMap((file) => (file.from ? [file.from, file.path] : [file.path]));
}

function assertNonRepositoryTurnCanBeRemoved(state: ChangeReviewRuntimeState, turnIndex: number): void {
	const turn = state.turns[turnIndex];
	if (!turn) throw new Error("The requested turn no longer exists");
	const laterFiles = state.turns.slice(turnIndex + 1).flatMap((entry) => entry.files);
	for (const file of turn.files) {
		if (findReviewFileByLineage(file, laterFiles)) {
			throw new Error(`A later turn also changed ${file.path}; revert the newer turn first`);
		}
	}
}

export function createChangeReviewMutationOwner(
	runtime: ChangeReviewRuntimeOwner,
	{ runBoundedGitWriteAtRoot }: GitWriteQueue,
	persist: ChangeReviewStore["persist"],
): ChangeReviewMutationOwner {
	const selectedScopeFiles = async (
		ref: SessionRef,
		snapshotId: string,
		scope: ChangeReviewScope,
		paths: readonly string[],
		action: ChangeReviewWriteAction,
		signal?: AbortSignal,
	): Promise<ReviewChangeFile[]> => {
		assertSafeWriteScope(action, scope);
		const state = await runtime.ensureState(ref);
		const computed = state.computed;
		if (!computed || computed.snapshotId !== snapshotId) {
			rejectStaleWriteSnapshot(state, action);
		}
		if (!computed.dto.isRepository) {
			throw new Error(`Cannot ${action} changes outside a Git repository`);
		}
		const current = await runtime.capture(ref.cwd, signal);
		if (changeReviewWorkspaceFingerprint(current) !== computed.workspaceFingerprint) {
			rejectStaleWriteSnapshot(state, action);
		}
		const scopeFiles = computed.scopes[scope].files;
		const filesByPath = new Map(scopeFiles.map((file) => [file.path, file]));
		const selectedFiles =
			paths.length > 0
				? paths.map((path) => {
						const file = filesByPath.get(path);
						if (!file) {
							throw new Error(`Path is not in ${scope} changes: ${path}`);
						}
						return file;
					})
				: scopeFiles;
		if (selectedFiles.length === 0) {
			throw new Error(`No changes to ${action}`);
		}
		for (const file of selectedFiles) {
			assertSafeWriteFile(action, file);
		}
		return selectedFiles;
	};

	const invalidateComputed = (ref: SessionRef): void => {
		const state = runtime.stateFor(ref);
		if (state) state.computed = undefined;
	};

	return {
		commit: (request) =>
			runtime.runForOpenProjectSession(request.ref, (canonicalRef) =>
				runBoundedGitWriteAtRoot(runtime.workspaceWriteKey(canonicalRef), async (signal) => {
					try {
						return await commitPaths(
							canonicalRef.cwd,
							request.message,
							pathsForFiles(
								await selectedScopeFiles(
									canonicalRef,
									request.snapshotId,
									request.scope,
									request.paths,
									"commit",
									signal,
								),
							),
							signal,
						);
					} finally {
						invalidateComputed(canonicalRef);
					}
				}),
			),
		revertTurn: (request) =>
			runtime.runForOpenProjectSession(request.ref, (canonicalRef) =>
				runBoundedGitWriteAtRoot(runtime.workspaceWriteKey(canonicalRef), async () => {
					const state = await runtime.ensureState(canonicalRef);
					if (state.activeTurn) {
						throw new Error("Cannot revert a turn while the agent is running");
					}
					const turnIndex = state.turns.findIndex((entry) => entry.id === request.turnId);
					const turn = state.turns[turnIndex];
					if (!turn) {
						throw new Error("The requested turn no longer exists");
					}
					if (turn.tracking.status !== "complete") {
						throw new Error("Only fully captured turns can be reverted");
					}
					if (turn.files.length === 0) {
						throw new Error("This turn changed no files");
					}
					const patches = turn.files.map((file) => file.diff);
					if (patches.some((diff) => diff === undefined || diff.length === 0)) {
						throw new Error("This turn's stored patches are incomplete; revert is unavailable");
					}
					const patch = patches.join("");
					const nonRepository = !state.baseline.isRepository;
					if (nonRepository) assertNonRepositoryTurnCanBeRemoved(state, turnIndex);
					try {
						// Stored per-file patches already retain their
						// terminal newline; plain concatenation recreates
						// the combined patch expected by git apply.
						await reverseApplyTurnPatch(canonicalRef.cwd, patch);
						if (nonRepository) {
							state.turns.splice(turnIndex, 1);
							try {
								await persist(state);
							} catch (persistError) {
								state.turns.splice(turnIndex, 0, turn);
								try {
									await restoreTurnPatch(canonicalRef.cwd, patch);
								} catch (restoreError) {
									// The files remain reverted, so keep the in-memory
									// projection aligned even though durable repair failed.
									state.turns.splice(turnIndex, 1);
									throw new AggregateError(
										[persistError, restoreError],
										"Ling reverted the turn but could not persist review state or restore the workspace",
									);
								}
								throw new Error("Ling could not persist the reverted review state; the workspace was restored", {
									cause: persistError,
								});
							}
						}
					} finally {
						state.computed = undefined;
						runtime.scheduleLiveUpdate(state);
					}
				}),
			),
		discard: (request) =>
			runtime.runForOpenProjectSession(request.ref, (canonicalRef) =>
				runBoundedGitWriteAtRoot(runtime.workspaceWriteKey(canonicalRef), async (signal) => {
					try {
						return await discardPaths(
							canonicalRef.cwd,
							pathsForFiles(
								await selectedScopeFiles(
									canonicalRef,
									request.snapshotId,
									request.scope,
									request.paths,
									"discard",
									signal,
								),
							),
							signal,
						);
					} finally {
						invalidateComputed(canonicalRef);
					}
				}),
			),
	};
}
