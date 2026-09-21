import type { ChangeOwner, ChangeReviewFile, ChangeReviewScope, ChangeScopeSummary } from "@ling/contracts/git";
import { createHash } from "node:crypto";

/**
 * Directories skipped by both the shadow Git capture and the project file watcher.
 * The watcher's ignore list must be a subset of this set: if the capture recorded a path the watcher cannot see,
 * cached previews would silently go stale; the list matches common dependency/cache directories to avoid
 * scanning node_modules-style noise.
 */
export const REVIEW_CAPTURE_EXCLUDED_DIRS = [
	".git",
	"node_modules",
	".pnpm-store",
	".yarn/cache",
	".venv",
	"venv",
	"__pycache__",
	".mypy_cache",
	".pytest_cache",
	".ruff_cache",
	".tox",
	"target",
	".gradle",
	".next",
	".turbo",
] as const;

export interface ReviewSnapshotFile {
	path: string;
	from?: string | undefined;
	status: ChangeReviewFile["status"];
	additions?: number | undefined;
	deletions?: number | undefined;
	/** Main-process-only patch data. Never include this field in an IPC snapshot. */
	diff?: string | undefined;
	/** Main-process-only content identity. Only its truncated form crosses IPC, as the
	 * opaque `contentTag` fingerprint (see main/change-review.ts toIpcFile). */
	identity?: string | undefined;
}

interface ReviewSnapshotInput {
	files: ReviewSnapshotFile[];
}

interface TurnChangeInput {
	files: ReviewSnapshotFile[];
}

export interface ReviewChangeFile extends ReviewSnapshotFile {
	owner: ChangeOwner;
}

export interface ReviewScopeSummary extends Omit<ChangeScopeSummary, "files"> {
	files: ReviewChangeFile[];
}

function fileKey(path: string): string {
	return process.platform === "win32" ? path.replace(/\\/g, "/") : path;
}

function writeIdentityPart(hash: ReturnType<typeof createHash>, value: string | number | undefined): void {
	if (value === undefined) {
		hash.update("u;");
		return;
	}
	const text = String(value);
	hash.update(`${Buffer.byteLength(text, "utf8")}:`);
	hash.update(text);
	hash.update(";");
}

/** Excludes the current path from the capture identity; rename lineage is matched
 * separately. Git capture must pass a blob identity for patchless untracked files. */
export function createReviewFileIdentity(file: ReviewSnapshotFile, contentIdentity?: string): string {
	const hash = createHash("sha256");
	writeIdentityPart(hash, file.status);
	writeIdentityPart(hash, file.from === undefined ? undefined : fileKey(file.from));
	writeIdentityPart(hash, file.additions);
	writeIdentityPart(hash, file.deletions);
	writeIdentityPart(hash, file.diff);
	writeIdentityPart(hash, contentIdentity);
	return hash.digest("hex");
}

function isReviewFileIdentity(value: string | undefined): value is string {
	return value !== undefined && /^[a-f0-9]{64}$/.test(value);
}

/** Missing or malformed identities are never treated as equal. */
export function sameReviewFileIdentity(left: ReviewSnapshotFile, right: ReviewSnapshotFile): boolean {
	return (
		isReviewFileIdentity(left.identity) && isReviewFileIdentity(right.identity) && left.identity === right.identity
	);
}

function lineageMatchRank(file: ReviewSnapshotFile, candidate: ReviewSnapshotFile): number {
	const path = fileKey(file.path);
	const from = file.from === undefined ? undefined : fileKey(file.from);
	const candidatePath = fileKey(candidate.path);
	const candidateFrom = candidate.from === undefined ? undefined : fileKey(candidate.from);
	if (candidatePath === path) return 0;
	if (from !== undefined && candidatePath === from) return 1;
	if (candidateFrom !== undefined && candidateFrom === path) return 2;
	if (from !== undefined && candidateFrom === from) return 3;
	return Number.POSITIVE_INFINITY;
}

/**
 * Path/lineage lookup built once per scope build. Keys are fileKey(path) and
 * fileKey(from) so rename lineage resolves without nested full-list scans.
 */
interface ReviewFileLineageIndex<T extends ReviewSnapshotFile> {
	byPath: Map<string, T[]>;
}

function buildReviewFileLineageIndex<T extends ReviewSnapshotFile>(
	candidates: readonly T[],
): ReviewFileLineageIndex<T> {
	const byPath = new Map<string, T[]>();
	const push = (key: string, file: T) => {
		const bucket = byPath.get(key);
		if (bucket) bucket.push(file);
		else byPath.set(key, [file]);
	};
	for (const file of candidates) {
		push(fileKey(file.path), file);
		if (file.from !== undefined) push(fileKey(file.from), file);
	}
	return { byPath };
}

function findInLineageIndex<T extends ReviewSnapshotFile>(
	file: ReviewSnapshotFile,
	index: ReviewFileLineageIndex<T>,
): T | undefined {
	const keys = [fileKey(file.path)];
	if (file.from !== undefined) keys.push(fileKey(file.from));
	const seen = new Set<T>();
	const candidates: T[] = [];
	for (const key of keys) {
		for (const candidate of index.byPath.get(key) ?? []) {
			if (seen.has(candidate)) continue;
			seen.add(candidate);
			candidates.push(candidate);
		}
	}
	return findReviewFileByLineage(file, candidates);
}

export function findReviewFileByLineage<T extends ReviewSnapshotFile>(
	file: ReviewSnapshotFile,
	candidates: readonly T[],
): T | undefined {
	let match: T | undefined;
	let bestRank = Number.POSITIVE_INFINITY;
	for (const candidate of candidates) {
		const rank = lineageMatchRank(file, candidate);
		if (rank >= bestRank) continue;
		match = candidate;
		bestRank = rank;
	}
	return match;
}

function findLatestTurnFile(
	file: ReviewSnapshotFile,
	turnIndexes: readonly ReviewFileLineageIndex<ReviewSnapshotFile>[],
): ReviewSnapshotFile | undefined {
	for (let index = turnIndexes.length - 1; index >= 0; index -= 1) {
		const turnIndex = turnIndexes[index];
		if (turnIndex === undefined) continue;
		const match = findInLineageIndex(file, turnIndex);
		if (match) return match;
	}
	return undefined;
}

/** Non-Git projects have no workspace status snapshot to classify. Fold the
 * persisted turn deltas into one latest record per rename lineage so a path
 * renamed across turns does not remain as both the old and new file. */
export function foldNonRepositoryTurnFiles(turns: readonly TurnChangeInput[]): ReviewSnapshotFile[] {
	const latest = new Map<string, ReviewSnapshotFile>();
	for (const turn of turns) {
		for (const file of turn.files) {
			if (file.status === "renamed" && file.from !== undefined) latest.delete(fileKey(file.from));
			const key = fileKey(file.path);
			if (file.status === "clean") latest.delete(key);
			else latest.set(key, file);
		}
	}
	return [...latest.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function toReviewChangeFile(file: ReviewSnapshotFile, owner: ChangeOwner): ReviewChangeFile {
	const next: ReviewChangeFile = { path: file.path, status: file.status, owner };
	if (file.from !== undefined) next.from = file.from;
	if (file.additions !== undefined) next.additions = file.additions;
	if (file.deletions !== undefined) next.deletions = file.deletions;
	if (file.diff !== undefined) next.diff = file.diff;
	if (file.identity !== undefined) next.identity = file.identity;
	return next;
}

function summarize(scope: ChangeReviewScope, files: ReviewChangeFile[]): ReviewScopeSummary {
	return {
		scope,
		count: files.length,
		additions: files.reduce((sum, file) => sum + (file.additions ?? 0), 0),
		deletions: files.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
		files,
	};
}

function classifyChangeFile(
	file: ReviewSnapshotFile,
	baselineIndex: ReviewFileLineageIndex<ReviewSnapshotFile>,
	turnIndexes: readonly ReviewFileLineageIndex<ReviewSnapshotFile>[],
): ReviewChangeFile {
	const baselineFile = findInLineageIndex(file, baselineIndex);
	const sessionFile = findLatestTurnFile(file, turnIndexes);
	let owner: ChangeOwner;
	if (baselineFile && sessionFile) owner = "mixed";
	else if (sessionFile) owner = sameReviewFileIdentity(file, sessionFile) ? "session" : "mixed";
	else if (baselineFile) owner = sameReviewFileIdentity(file, baselineFile) ? "preexisting" : "mixed";
	else owner = "external";
	return toReviewChangeFile(file, owner);
}

function classifyWorkspaceChanges(
	current: ReviewSnapshotInput,
	baselineIndex: ReviewFileLineageIndex<ReviewSnapshotFile>,
	turnIndexes: readonly ReviewFileLineageIndex<ReviewSnapshotFile>[],
): ReviewChangeFile[] {
	return current.files
		.map((file) => classifyChangeFile(file, baselineIndex, turnIndexes))
		.sort((a, b) => a.path.localeCompare(b.path));
}

/** A turn inherits the current workspace ownership for the same rename lineage. When
 * its result is already clean, touching baseline-owned content is still mixed. */
export function buildTurnReviewScope(
	files: readonly ReviewSnapshotFile[],
	workspaceFiles: readonly ReviewChangeFile[],
	baseline: ReviewSnapshotInput,
): ReviewScopeSummary {
	const workspaceIndex = buildReviewFileLineageIndex(workspaceFiles);
	const baselineIndex = buildReviewFileLineageIndex(baseline.files);
	return summarize(
		"turn",
		files.map((file) => {
			const current = findInLineageIndex(file, workspaceIndex);
			if (current) return toReviewChangeFile(file, current.owner);
			const owner: ChangeOwner = findInLineageIndex(file, baselineIndex) ? "mixed" : "session";
			return toReviewChangeFile(file, owner);
		}),
	);
}

export function buildChangeScopes(
	current: ReviewSnapshotInput,
	baseline: ReviewSnapshotInput,
	turns: readonly TurnChangeInput[],
	unpushed: ReviewSnapshotInput,
): Record<ChangeReviewScope, ReviewScopeSummary> {
	// One index pass for baseline + each turn; classify reuses them instead of
	// nested full-list lineage scans per workspace file.
	const baselineIndex = buildReviewFileLineageIndex(baseline.files);
	const turnIndexes = turns.map((turn) => buildReviewFileLineageIndex(turn.files));
	const workspace = classifyWorkspaceChanges(current, baselineIndex, turnIndexes);
	const workspaceIndex = buildReviewFileLineageIndex(workspace);
	const latestTurn = turns.at(-1);
	// Fold rename lineage across turns the same way non-repo fold does: a rename
	// retires `from`, later paths win. Path-only first-seen left both `a` and `b`
	// after a→b when neither remains in the workspace.
	const committedLatest = new Map<string, ReviewSnapshotFile>();
	for (const turn of turns) {
		for (const file of turn.files) {
			if (findInLineageIndex(file, workspaceIndex)) continue;
			if (file.status === "renamed" && file.from !== undefined) {
				committedLatest.delete(fileKey(file.from));
			}
			const key = fileKey(file.path);
			if (file.status === "clean") committedLatest.delete(key);
			else committedLatest.set(key, file);
		}
	}
	const committed = [...committedLatest.values()]
		.sort((left, right) => left.path.localeCompare(right.path))
		.map((file): ReviewChangeFile => ({
			path: file.path,
			status: "clean",
			additions: 0,
			deletions: 0,
			diff: "",
			owner: "committed",
		}));
	return {
		turn:
			latestTurn === undefined ? summarize("turn", []) : buildTurnReviewScope(latestTurn.files, workspace, baseline),
		session: summarize(
			"session",
			workspace.filter((file) => file.owner === "session" || file.owner === "mixed"),
		),
		workspace: summarize("workspace", workspace),
		unpushed: summarize(
			"unpushed",
			unpushed.files
				.map((file) => toReviewChangeFile(file, "committed"))
				.sort((left, right) => left.path.localeCompare(right.path)),
		),
		preexisting: summarize(
			"preexisting",
			workspace.filter((file) => file.owner === "preexisting"),
		),
		external: summarize(
			"external",
			workspace.filter((file) => file.owner === "external"),
		),
		mixed: summarize(
			"mixed",
			workspace.filter((file) => file.owner === "mixed"),
		),
		committed: summarize("committed", committed),
	};
}
