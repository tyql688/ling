import type { z } from "zod";
import type * as requestSchemas from "./git-requests";
type RequestSchemasShape = ReturnType<typeof requestSchemas.createGitRequestSchemas>;

import type { DatasetStoreStatus } from "./dataset-status";
import type { SessionRef } from "./session-ref";

// Windows CreateProcess limits the entire command line to 32,767 UTF-16 code units.
// Git commits may combine a message with 512 `:(literal)` pathspec arguments, so
// each variable text family receives at most 8,192 UTF-16 code units and leaves the remaining budget
// for pathspec prefixes, quoting expansion, fixed flags, and the executable path.
/** Max characters per pathspec; leaves room for prefixes/quoting/flags within the 32,767 CreateProcess budget so the Windows command line can't overflow. */
export const GIT_PATH_MAX_CHARS = 8 * 1_024;
/** Max characters for a commit message; same 8 Ki quota as the path family so message + paths combined can't break the CreateProcess limit. */
export const GIT_COMMIT_MESSAGE_MAX_CHARS = 8 * 1_024;
/** Max total characters across selected paths; a cap on the batched pathspec length that shares the command-line budget with per-path/message limits. */
export const GIT_SELECTED_PATHS_TOTAL_MAX_CHARS = 8 * 1_024;
/** Max number of selected paths; aligns with the `:(literal)` batch size (512) and keeps the argv array from growing unbounded. */
export const GIT_SELECTED_PATHS_MAX_ITEMS = 512;

// Branch and revision are used in short commands without a path batch. These caps
// preserve the existing public contract while remaining well below the process limit.
/** Max characters for a branch name; used in short commands, keeps the public contract and stays well under the process command-line limit. */
export const GIT_BRANCH_MAX_CHARS = 1_024;
/** Max characters for a revision/ref; allows longer ref expressions while staying well under the total CreateProcess budget. */
export const GIT_REVISION_MAX_CHARS = 4 * 1_024;

// Cwd is process metadata rather than an argv entry and follows Ling's long-path IPC boundary.
/** Max characters for the working-directory path; cwd is not an argv entry and aligns with Ling's 32 KiB long-path IPC boundary. */
export const GIT_CWD_MAX_CHARS = 32 * 1_024;

export interface GitStatus {
	isRepository: boolean;
	currentBranch: string | null;
	/** Short HEAD sha, only resolved while HEAD is detached (currentBranch === null in a repo) —
	 * the branch pill then labels itself "HEAD@<sha>" instead of disappearing. */
	detachedHeadSha: string | null;
	/** Number of changed files inside the selected project cwd, not the entire containing repository. */
	changedFiles: number;
	ahead: number;
	behind: number;
	hasRemote: boolean;
}

export type GitGraphRefKind = "local" | "remote" | "tag";

export interface GitGraphRef {
	/** Short display name: `main`, `origin/main`, or `v1.0.0`. */
	name: string;
	/** Full Git ref name used only as an opaque identity. */
	fullName: string;
	kind: GitGraphRefKind;
	commit: string;
}

export interface GitGraphCommit {
	sha: string;
	parents: string[];
	subject: string;
	author: string;
	/** Unix epoch milliseconds. */
	authoredAt: number;
}

export interface GitGraph {
	headSha: string | null;
	currentBranch: string | null;
	commits: GitGraphCommit[];
	refs: GitGraphRef[];
	/** More commits exist beyond the bounded history window. */
	truncated: boolean;
}

export type GitChangedFileStatus = "modified" | "added" | "deleted" | "renamed" | "copied" | "untracked" | "conflicted";

export interface GitChangedFile {
	/** Project-cwd-relative Git path. Never repository-root-relative for a nested project. */
	path: string;
	status: GitChangedFileStatus;
	from?: string;
	additions?: number;
	deletions?: number;
}

type ChangeReviewFileStatus = GitChangedFileStatus | "clean";
export type ChangeOwner = "session" | "preexisting" | "external" | "mixed" | "committed" | "unknown";
export type ChangeReviewScope =
	"turn" | "session" | "workspace" | "unpushed" | "preexisting" | "external" | "mixed" | "committed";

export interface ChangeReviewFile {
	path: string;
	status: ChangeReviewFileStatus;
	owner: ChangeOwner;
	from?: string;
	additions?: number;
	deletions?: number;
	/** Opaque fingerprint of the file's current change content (truncated content hash).
	 * Any content change produces a new tag — reviewed-state invalidation keys off it so
	 * two different edits with coincidentally equal line counts cannot be confused. */
	contentTag?: string;
}

export interface ChangeScopeSummary {
	scope: ChangeReviewScope;
	count: number;
	additions: number;
	deletions: number;
	files: ChangeReviewFile[];
}

export type ChangeReviewPartialReason =
	"shadowCaptureFailed" | "captureLimitExceeded" | "toolFallbackFailed" | "legacyTracking";

export type ChangeReviewTrackingState =
	{ status: "capturing" } | { status: "complete" } | { status: "partial"; reason: ChangeReviewPartialReason };

export type ChangeReviewUnpushedState =
	| {
			status: "ready";
			/** Configured upstream ref used as the comparison target, for example `origin/main`. */
			comparisonRef: string;
			/** Merge base between the push target and HEAD. */
			baseSha: string;
			/** Immutable HEAD captured with the unpushed diff. */
			headSha: string;
			commitCount: number;
	  }
	| { status: "unavailable"; reason: "noUpstream" }
	| { status: "error"; message: string };

export interface ChangeReviewSnapshot {
	snapshotId: string;
	ref: SessionRef;
	cwd: string;
	isRepository: boolean;
	gitRoot: string | null;
	branch: string | null;
	headSha: string | null;
	baselineHeadSha: string | null;
	/** Read-only review state for commits reachable from HEAD but not its local push-tracking ref. */
	unpushed: ChangeReviewUnpushedState;
	turns: Array<{
		id: string;
		startedAt: number;
		endedAt: number;
		/** Durable entry id of the user message that initiated the turn; links a review
		 * turn to its transcript position without fragile timestamp matching. */
		userMessageEntryId: string | null;
		tracking: ChangeReviewTrackingState;
		summary: ChangeScopeSummary;
	}>;
	tracking: {
		turn: ChangeReviewTrackingState;
		session: ChangeReviewTrackingState;
	};
	scopes: Record<ChangeReviewScope, ChangeScopeSummary>;
}

export type RevertChangeReviewTurnRequest = z.infer<RequestSchemasShape["revertChangeReviewTurnRequestSchema"]>;

export type ChangeReviewStateStatus = DatasetStoreStatus;

export type ChangeReviewTrackingEvent =
	| { type: "started"; ref: SessionRef }
	| { type: "updated"; ref: SessionRef }
	| { type: "settled"; ref: SessionRef }
	| { type: "failed"; ref: SessionRef; errorCode: "CHANGE_REVIEW_TRACKING_FAILED" };

export const CHANGE_REVIEW_DIFF_CONTEXT_MIN_LINES = 4;
export const CHANGE_REVIEW_DIFF_CONTEXT_MAX_LINES = 1_000;

export type ChangeReviewDiffRequest = z.infer<RequestSchemasShape["changeReviewDiffRequestSchema"]>;

export interface ChangeReviewDiffResponse {
	requestId: string;
	diff: string;
	/** Complete UTF-8 file sides for Monaco. Immutable turn patches may omit this because
	 * their replaced bytes are not persisted; the unified diff remains authoritative there. */
	editor?:
		{ status: "available"; original: string; modified: string } | { status: "error"; message: string } | undefined;
}

export type CancelChangeReviewDiffRequest = z.infer<RequestSchemasShape["cancelChangeReviewDiffRequestSchema"]>;

export interface CancelChangeReviewDiffResponse {
	requestId: string;
	accepted: boolean;
}

export type CommitChangeReviewRequest = z.infer<RequestSchemasShape["commitChangeReviewRequestSchema"]>;

export type DiscardChangeReviewRequest = z.infer<RequestSchemasShape["discardChangeReviewRequestSchema"]>;

export interface WorktreeInfo {
	path: string;
	canonicalPath: string;
	branchName: string | null;
	headSha: string;
	detached: boolean;
	primary: boolean;
}

export interface WorktreeBranchOption {
	name: string;
	/** Existing checkout path; null means the branch is available for a new worktree. */
	checkedOutPath: string | null;
}

export type CreateWorktreeRequest = z.infer<RequestSchemasShape["createWorktreeRequestSchema"]>;

export type RemoveWorktreeRequest = z.infer<RequestSchemasShape["removeWorktreeRequestSchema"]>;

/** A commit id as git prints it: lowercase hex, abbreviated or full. */
export const GIT_COMMIT_SHA_PATTERN = /^[0-9a-f]{7,64}$/;

export type CommitChangedFilesRequest = z.infer<RequestSchemasShape["commitChangedFilesRequestSchema"]>;

export type CommitFileDiffRequest = z.infer<RequestSchemasShape["commitFileDiffRequestSchema"]>;

export type SwitchBranchRequest = z.infer<RequestSchemasShape["switchBranchRequestSchema"]>;

export type CreateBranchRequest = z.infer<RequestSchemasShape["createBranchRequestSchema"]>;

/** Commits every change inside cwd while leaving sibling repository paths untouched. */
export type CommitAllRequest = z.infer<RequestSchemasShape["commitAllRequestSchema"]>;

export interface GitCommitResult {
	commit: string;
	branch: string | null;
}

export type PushBranchRequest = z.infer<RequestSchemasShape["pushBranchRequestSchema"]>;
