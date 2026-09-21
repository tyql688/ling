import type {
	ChangeReviewDiffRequest,
	ChangeReviewDiffResponse,
	ChangeReviewFile,
	ChangeReviewSnapshot,
	ChangeReviewStateStatus,
	ChangeReviewTrackingState,
	ChangeReviewUnpushedState,
	ChangeScopeSummary,
} from "@ling/contracts/git";
import type { SessionRef } from "@ling/contracts/session";
import {
	buildChangeScopes,
	buildTurnReviewScope,
	findReviewFileByLineage,
	foldNonRepositoryTurnFiles,
	sameReviewFileIdentity,
	type ReviewChangeFile,
	type ReviewScopeSummary,
	type ReviewSnapshotFile,
} from "@ling/core/change-review/change-review";
import {
	getChangedFileDiff,
	getGitRevisionFileDiff,
	getGitUnpushedReviewSnapshot,
	readGitBlobAtCommit,
	readGitBlobAtHead,
	type GitReviewSnapshot,
	type GitUnpushedReviewSnapshot,
} from "@ling/host/domains/git/git-service";
import { throwIfOperationAborted, toError } from "@ling/core/ling-error";
import { restoreReviewTextSides, type ReviewTextSides } from "@ling/core/change-review/change-review-context";
import { createLogger } from "@ling/core/logger";
import { DatasetReadError, datasetStoreStatusFromError } from "@ling/host/storage/dataset-envelope";
import { readWorkspaceTextFile } from "@ling/host/domains/files/project-files";
import { LRUCache } from "lru-cache";
import { createHash, randomUUID } from "node:crypto";
import type { ChangeReviewRuntimeOwner } from "./change-review-runtime";
import { partialReasonForShadowFailure } from "./change-review-shadow";
import type { ChangeReviewRuntimeState, ComputedChangeReviewSnapshot } from "./change-review-state";
import { withoutPatches, type ChangeReviewStore } from "./change-review-store";

const log = createLogger("change-review-query");

/**
 * Disk-read cap for untracked-file diffs. 2MiB shows meaningful added text; larger files
 * are unrenderable in the UI anyway, so truncate/refuse rather than let one file blow up
 * IPC and rendering.
 */
const MAX_UNTRACKED_DIFF_BYTES = 2 * 1024 * 1024;
/** A pair of 8MiB UTF-8 sides stays below the existing 16MiB Git-blob boundary while keeping
 * review rendering responsive; oversized text still renders through the bounded unified diff. */
const MAX_REVIEW_SIDE_BYTES = 8 * 1024 * 1024;

/**
 * Retention budget for diffs computed on demand within one snapshot. Expanding context refetches
 * the same file at 100-line steps up to CHANGE_REVIEW_DIFF_CONTEXT_MAX_LINES, so browsing a
 * repository caches one full-file patch per file per step, and only snapshot invalidation drops
 * them — which reading alone never triggers. Retain at most 32M UTF-16 code units;
 * a larger diff is returned to its caller without being retained.
 */
const MAX_DYNAMIC_DIFF_CACHE_CHARS = 32 * 1024 * 1024;

interface ChangeReviewQueryOwner {
	getSnapshot(ref: SessionRef): Promise<ChangeReviewSnapshot>;
	getStateStatus(ref: SessionRef): Promise<ChangeReviewStateStatus>;
	resetState(ref: SessionRef): Promise<ChangeReviewSnapshot>;
	getDiff(request: ChangeReviewDiffRequest, signal?: AbortSignal): Promise<Omit<ChangeReviewDiffResponse, "requestId">>;
}

function writeFingerprintValue(
	hash: ReturnType<typeof createHash>,
	value: string | number | boolean | null | undefined,
): void {
	if (value === undefined) {
		hash.update("u;");
		return;
	}
	if (value === null) {
		hash.update("n;");
		return;
	}
	const text = String(value);
	hash.update(`${Buffer.byteLength(text, "utf8")}:`);
	hash.update(text);
	hash.update(";");
}

export function changeReviewWorkspaceFingerprint(snapshot: GitReviewSnapshot): string {
	const hash = createHash("sha256");
	writeFingerprintValue(hash, snapshot.isRepository);
	writeFingerprintValue(hash, snapshot.gitRoot);
	writeFingerprintValue(hash, snapshot.headSha);
	writeFingerprintValue(hash, snapshot.branch);
	for (const file of snapshot.files) {
		writeFingerprintValue(hash, file.path);
		writeFingerprintValue(hash, file.from);
		writeFingerprintValue(hash, file.status);
		writeFingerprintValue(hash, file.additions);
		writeFingerprintValue(hash, file.deletions);
		writeFingerprintValue(hash, file.diff);
		writeFingerprintValue(hash, file.identity);
	}
	return hash.digest("hex");
}

interface UnpushedReviewCapture {
	snapshot: GitUnpushedReviewSnapshot | null;
	state: ChangeReviewUnpushedState;
}

async function captureUnpushedReview(cwd: string, isRepository: boolean): Promise<UnpushedReviewCapture> {
	if (!isRepository) return { snapshot: null, state: { status: "unavailable", reason: "noUpstream" } };
	try {
		const snapshot = await getGitUnpushedReviewSnapshot(cwd);
		if (snapshot === null) {
			return { snapshot: null, state: { status: "unavailable", reason: "noUpstream" } };
		}
		return {
			snapshot,
			state: {
				status: "ready",
				comparisonRef: snapshot.comparisonRef,
				baseSha: snapshot.baseSha,
				headSha: snapshot.headSha,
				commitCount: snapshot.commitCount,
			},
		};
	} catch (error) {
		const failure = toError(error);
		log.error("failed to capture unpushed changes:", failure);
		return { snapshot: null, state: { status: "error", message: failure.message } };
	}
}

function toIpcFile(file: ReviewChangeFile): ChangeReviewFile {
	const result: ChangeReviewFile = {
		path: file.path,
		status: file.status,
		owner: file.owner,
	};
	if (file.from !== undefined) result.from = file.from;
	if (file.additions !== undefined) {
		result.additions = file.additions;
	}
	if (file.deletions !== undefined) {
		result.deletions = file.deletions;
	}
	// The full identity stays main-only. This opaque prefix is enough for
	// renderer-side reviewed-mark invalidation.
	if (file.identity !== undefined) {
		result.contentTag = file.identity.slice(0, 16);
	}
	return result;
}

function toIpcSummary(summary: ReviewScopeSummary): ChangeScopeSummary {
	return {
		scope: summary.scope,
		count: summary.count,
		additions: summary.additions,
		deletions: summary.deletions,
		files: summary.files.map(toIpcFile),
	};
}

async function activeTurnFiles(
	runtime: ChangeReviewRuntimeOwner,
	state: ChangeReviewRuntimeState,
): Promise<ReviewSnapshotFile[] | null> {
	const active = state.activeTurn;
	if (!active) return null;
	if (active.shadowCheckpoint === null || active.tracking.status === "partial") {
		return [...active.trackedFiles.values()].sort((left, right) => left.path.localeCompare(right.path));
	}
	const clockBefore = state.watcher?.clock() ?? null;
	if (active.preview !== null && clockBefore !== null && active.preview.clock === clockBefore) {
		return active.preview.files;
	}
	try {
		const files = (await runtime.ensureShadowSession(state).preview(active.shadowCheckpoint)).files;
		if (clockBefore !== null && state.watcher?.clock() === clockBefore) {
			active.preview = { clock: clockBefore, files };
		}
		return files;
	} catch (error) {
		log.warn(
			`Live change capture failed for ${state.ref.sessionId}; the turn will retry its original baseline:`,
			error,
		);
		active.tracking = {
			status: "partial",
			reason: partialReasonForShadowFailure(error),
		};
		// A clone or atomic replacement can leave files temporarily unreadable. Keep the
		// original tree for the final capture, without repeating a failing scan on every refresh.
		return [...active.trackedFiles.values()].sort((left, right) => left.path.localeCompare(right.path));
	}
}

function turnTrackingState(state: ChangeReviewRuntimeState): ChangeReviewTrackingState {
	return state.activeTurn?.tracking ?? state.turns.at(-1)?.tracking ?? { status: "complete" };
}

function sessionTrackingState(state: ChangeReviewRuntimeState): ChangeReviewTrackingState {
	const partial = [...state.turns.map((turn) => turn.tracking), state.activeTurn?.tracking].find(
		(tracking): tracking is Extract<ChangeReviewTrackingState, { status: "partial" }> => tracking?.status === "partial",
	);
	if (partial) return partial;
	if (state.activeTurn) return { status: "capturing" };
	return { status: "complete" };
}

function fileForRequest(
	computed: ComputedChangeReviewSnapshot,
	request: ChangeReviewDiffRequest,
): ReviewChangeFile | undefined {
	if (request.scope === "turn" && request.turnId) {
		return computed.turns
			.find((turn) => turn.id === request.turnId)
			?.summary.files.find((file) => file.path === request.path);
	}
	return computed.scopes[request.scope].files.find((file) => file.path === request.path);
}

function addedTextDiff(text: string): string {
	const normalized = text.replaceAll("\r\n", "\n");
	if (normalized.length === 0) return "";
	const endsWithNewline = normalized.endsWith("\n");
	const lines = normalized.split("\n");
	if (endsWithNewline) lines.pop();
	const body = lines.map((line) => `+${line}`).join("\n");
	return `@@ -0,0 +1,${lines.length} @@\n${body}${endsWithNewline ? "\n" : "\n\\ No newline at end of file"}`;
}

function decodeReviewText(bytes: Buffer, path: string): string {
	if (bytes.byteLength > MAX_REVIEW_SIDE_BYTES) throw new Error(`Review file is too large: ${path}`);
	if (bytes.includes(0)) throw new Error(`Review file appears to be binary: ${path}`);
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch (error) {
		throw new Error(`Review file is not valid UTF-8: ${path}`, { cause: error });
	}
}

async function readWorkspaceEditorSides(
	cwd: string,
	file: ReviewChangeFile,
	signal?: AbortSignal,
): Promise<{ original: string; modified: string }> {
	const originalPath = file.from ?? file.path;
	const original =
		file.status === "added" || file.status === "untracked"
			? ""
			: await readGitBlobAtHead(cwd, originalPath, signal).then((bytes) => {
					if (bytes === null) throw new Error(`Committed review file is unavailable: ${originalPath}`);
					return decodeReviewText(bytes, originalPath);
				});
	throwIfOperationAborted(signal);
	const modified =
		file.status === "deleted" ? "" : await readWorkspaceTextFile(cwd, file.path, { maxBytes: MAX_REVIEW_SIDE_BYTES });
	throwIfOperationAborted(signal);
	return { original, modified };
}

async function readRevisionEditorSides(
	cwd: string,
	file: ReviewChangeFile,
	baseSha: string,
	headSha: string,
	signal?: AbortSignal,
): Promise<{ original: string; modified: string }> {
	const originalPath = file.from ?? file.path;
	const original =
		file.status === "added"
			? ""
			: await readGitBlobAtCommit(cwd, baseSha, originalPath, signal).then((bytes) => {
					if (bytes === null) throw new Error(`Unpushed review base is unavailable: ${originalPath}`);
					return decodeReviewText(bytes, originalPath);
				});
	throwIfOperationAborted(signal);
	const modified =
		file.status === "deleted"
			? ""
			: await readGitBlobAtCommit(cwd, headSha, file.path, signal).then((bytes) => {
					if (bytes === null) throw new Error(`Unpushed review file is unavailable: ${file.path}`);
					return decodeReviewText(bytes, file.path);
				});
	throwIfOperationAborted(signal);
	return { original, modified };
}

function dynamicDiffKey(request: ChangeReviewDiffRequest): string {
	return [
		request.scope,
		request.turnId === undefined ? "" : request.turnId,
		request.path,
		request.contextLines === undefined ? "" : String(request.contextLines),
	].join("\u0000");
}

function rejectStaleDiffSnapshot(state: ChangeReviewRuntimeState): never {
	state.computed = undefined;
	throw new Error("The change review snapshot is stale; refresh it before loading a diff");
}

/** A saved turn patch may outlive its source files. Hash checks keep later edits out of its context. */
async function readSavedPatchSides(
	state: ChangeReviewRuntimeState,
	request: ChangeReviewDiffRequest,
	file: ReviewChangeFile,
	diff: string,
	signal?: AbortSignal,
): Promise<ReviewTextSides | null> {
	if (!/^index [0-9a-f]+\.\.[0-9a-f]+/m.test(diff)) return null;
	const emptySide = restoreReviewTextSides(diff, "");
	if (emptySide !== null) return emptySide;
	const turn =
		request.turnId === undefined ? state.turns.at(-1) : state.turns.find((item) => item.id === request.turnId);
	const head = request.turnId === undefined && state.activeTurn ? state.activeTurn.beforeHeadSha : turn?.beforeHeadSha;
	if (head != null) {
		const bytes = await readGitBlobAtCommit(request.ref.cwd, head, file.from ?? file.path, signal);
		if (bytes !== null) {
			const sides = restoreReviewTextSides(diff, decodeReviewText(bytes, file.from ?? file.path));
			if (sides !== null) return sides;
		}
	}
	throwIfOperationAborted(signal);
	if (file.status === "deleted") return null;
	const text = await readWorkspaceTextFile(request.ref.cwd, file.path, { maxBytes: MAX_REVIEW_SIDE_BYTES });
	throwIfOperationAborted(signal);
	return restoreReviewTextSides(diff, text);
}

export function createChangeReviewQueryOwner(
	runtime: ChangeReviewRuntimeOwner,
	store: Pick<ChangeReviewStore, "inspectStoredStateFailure" | "recoverState">,
): ChangeReviewQueryOwner {
	const { inspectStoredStateFailure } = store;
	const computeSnapshot = async (ref: SessionRef): Promise<ComputedChangeReviewSnapshot> => {
		const state = await runtime.ensureState(ref);
		const captured = await runtime.capture(ref.cwd);
		if (!state.activeTurn) {
			await runtime.alignRepositoryMode(state, captured);
		}
		const activeFiles = await activeTurnFiles(runtime, state);
		const scopeTurns = activeFiles === null ? state.turns : [...state.turns, { files: activeFiles }];
		const current = captured.isRepository
			? captured
			: {
					...captured,
					files: foldNonRepositoryTurnFiles(scopeTurns),
				};
		const unpushed = await captureUnpushedReview(ref.cwd, current.isRepository);
		const scopes = buildChangeScopes(current, state.baseline, scopeTurns, {
			files: unpushed.snapshot?.files ?? [],
		});
		const turns = state.turns.map((turn) => ({
			id: turn.id,
			startedAt: turn.startedAt,
			endedAt: turn.endedAt,
			userMessageEntryId: turn.userMessageEntryId,
			tracking: turn.tracking,
			summary: buildTurnReviewScope(turn.files, scopes.workspace.files, state.baseline),
		}));
		const snapshotId = randomUUID();
		const dto: ChangeReviewSnapshot = {
			snapshotId,
			ref,
			cwd: ref.cwd,
			isRepository: current.isRepository,
			gitRoot: current.gitRoot,
			branch: current.branch,
			headSha: current.headSha,
			baselineHeadSha: state.baseline.headSha,
			unpushed: unpushed.state,
			turns: turns.map((turn) => ({
				...turn,
				summary: toIpcSummary(turn.summary),
			})),
			tracking: {
				turn: turnTrackingState(state),
				session: sessionTrackingState(state),
			},
			scopes: {
				turn: toIpcSummary(scopes.turn),
				session: toIpcSummary(scopes.session),
				workspace: toIpcSummary(scopes.workspace),
				unpushed: toIpcSummary(scopes.unpushed),
				preexisting: toIpcSummary(scopes.preexisting),
				external: toIpcSummary(scopes.external),
				mixed: toIpcSummary(scopes.mixed),
				committed: toIpcSummary(scopes.committed),
			},
		};
		const computed: ComputedChangeReviewSnapshot = {
			snapshotId,
			workspaceFingerprint: changeReviewWorkspaceFingerprint(current),
			unpushed: unpushed.snapshot,
			dto,
			scopes,
			turns: turns.map(({ id, summary }) => ({
				id,
				summary,
			})),
			dynamicDiffs: new LRUCache<string, string>({
				maxSize: MAX_DYNAMIC_DIFF_CACHE_CHARS,
				// Empty diffs remain cacheable; lru-cache requires a positive size.
				sizeCalculation: (diff) => Math.max(1, diff.length),
			}),
		};
		state.computed = computed;
		return computed;
	};

	const validateDynamicDiffSnapshot = async (
		state: ChangeReviewRuntimeState,
		computed: ComputedChangeReviewSnapshot,
		ref: SessionRef,
		file: ReviewChangeFile,
		signal?: AbortSignal,
	): Promise<void> => {
		const current = await runtime.capture(ref.cwd, signal);
		const currentFile = findReviewFileByLineage(file, current.files);
		if (
			changeReviewWorkspaceFingerprint(current) !== computed.workspaceFingerprint ||
			currentFile === undefined ||
			!sameReviewFileIdentity(file, currentFile)
		) {
			rejectStaleDiffSnapshot(state);
		}
	};

	const getDiff = async (
		request: ChangeReviewDiffRequest,
		signal?: AbortSignal,
	): Promise<Omit<ChangeReviewDiffResponse, "requestId">> => {
		throwIfOperationAborted(signal);
		const state = await runtime.ensureState(request.ref);
		const computed = state.computed;
		if (!computed || computed.snapshotId !== request.snapshotId) {
			throw new Error("The change review snapshot is stale; refresh it before loading a diff");
		}
		const file = fileForRequest(computed, request);
		if (!file) rejectStaleDiffSnapshot(state);
		const expandsRepositoryDiff =
			request.contextLines !== undefined && request.scope !== "turn" && computed.dto.isRepository;
		let diff = !expandsRepositoryDiff && file.diff !== undefined && file.diff.length > 0 ? file.diff : undefined;
		if (diff === undefined && computed.dto.isRepository && file.status !== "clean") {
			const cacheKey = dynamicDiffKey(request);
			diff = computed.dynamicDiffs.get(cacheKey);
			if (diff === undefined) {
				if (request.scope === "unpushed") {
					const capture = computed.unpushed;
					if (capture === null) rejectStaleDiffSnapshot(state);
					diff = await getGitRevisionFileDiff(
						request.ref.cwd,
						capture.baseSha,
						capture.headSha,
						file.path,
						signal,
						request.contextLines,
					);
				} else {
					diff = await getChangedFileDiff(request.ref.cwd, file.path, signal, request.contextLines);
					if (diff.length === 0 && file.status === "untracked") {
						throwIfOperationAborted(signal);
						const text = await readWorkspaceTextFile(request.ref.cwd, file.path, {
							maxBytes: MAX_UNTRACKED_DIFF_BYTES,
						});
						throwIfOperationAborted(signal);
						diff = addedTextDiff(text);
					}
					await validateDynamicDiffSnapshot(state, computed, request.ref, file, signal);
				}
				throwIfOperationAborted(signal);
				computed.dynamicDiffs.set(cacheKey, diff);
			}
		}
		diff ??= file.diff ?? "";

		if (file.status === "clean") return { diff };
		try {
			let editor: { original: string; modified: string };
			if (request.scope === "turn" || !computed.dto.isRepository) {
				const sides = await readSavedPatchSides(state, request, file, diff, signal);
				if (sides === null) return { diff };
				if (
					Buffer.byteLength(sides.original, "utf8") > MAX_REVIEW_SIDE_BYTES ||
					Buffer.byteLength(sides.modified, "utf8") > MAX_REVIEW_SIDE_BYTES
				)
					throw new Error(`Review file is too large: ${file.path}`);
				editor = sides;
			} else if (request.scope === "unpushed") {
				const capture = computed.unpushed;
				if (capture === null) rejectStaleDiffSnapshot(state);
				editor = await readRevisionEditorSides(request.ref.cwd, file, capture.baseSha, capture.headSha, signal);
			} else {
				editor = await readWorkspaceEditorSides(request.ref.cwd, file, signal);
			}
			return { diff, editor: { status: "available", ...editor } };
		} catch (error) {
			throwIfOperationAborted(signal);
			return { diff, editor: { status: "error", message: toError(error).message } };
		}
	};

	return {
		getSnapshot: (ref) =>
			runtime.runForOpenProjectSession(ref, async (canonicalRef) => (await computeSnapshot(canonicalRef)).dto),
		getStateStatus: (ref) =>
			runtime.runForOpenProjectSession(ref, async (canonicalRef) => {
				if (runtime.hasState(canonicalRef)) {
					return { status: "ready" };
				}
				const failure = await inspectStoredStateFailure(canonicalRef);
				return failure ? datasetStoreStatusFromError(failure) : { status: "ready" };
			}),
		resetState: (ref) =>
			runtime.runForOpenProjectSession(ref, async (canonicalRef) => {
				if (runtime.hasState(canonicalRef)) {
					throw new Error("Change review state recovery is not required");
				}
				const failure = await inspectStoredStateFailure(canonicalRef);
				if (!failure) {
					throw new Error("Change review state recovery is not required");
				}
				if (!(failure instanceof DatasetReadError)) {
					throw new Error("Change review state recovery is temporarily unavailable", { cause: failure });
				}
				const baseline = withoutPatches(await runtime.capture(canonicalRef.cwd));
				const replacement: ChangeReviewRuntimeState = {
					ref: canonicalRef,
					cwd: canonicalRef.cwd,
					baseline,
					turns: [],
				};
				try {
					await store.recoverState(replacement);
					runtime.adoptState(replacement);
					return (await computeSnapshot(canonicalRef)).dto;
				} catch (error) {
					await runtime.discardState(replacement).catch(() => {
						// Preserve the recovery failure as the primary
						// renderer diagnosis.
					});
					throw new Error("Ling could not rebuild change review state", { cause: error });
				}
			}),
		getDiff: (request, signal) =>
			runtime.runForOpenProjectSession(request.ref, (canonicalRef) =>
				getDiff({ ...request, ref: canonicalRef }, signal),
			),
	};
}
