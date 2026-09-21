import type { ChangeReviewScope, ChangeReviewSnapshot, ChangeReviewTrackingState } from "@ling/contracts/git";
import type { SessionRef } from "@ling/contracts/session";
import type { GitReviewSnapshot, GitUnpushedReviewSnapshot } from "@ling/host/domains/git/git-service";
import type { ReviewScopeSummary, ReviewSnapshotFile } from "@ling/core/change-review/change-review";
import type { ProjectFileWatcherLease } from "@ling/host/domains/review/project-file-watcher";
import type { LRUCache } from "lru-cache";
import type { ShadowGitCheckpoint, ShadowGitSession } from "./change-review-shadow";

export type StoredTurnTrackingState = Exclude<ChangeReviewTrackingState, { status: "capturing" }>;

interface StoredTurnChangeSet {
	id: string;
	startedAt: number;
	endedAt: number;
	beforeHeadSha: string | null;
	afterHeadSha: string | null;
	/** Durable transcript entry id of the user message that initiated this turn. */
	userMessageEntryId: string | null;
	tracking: StoredTurnTrackingState;
	files: ReviewSnapshotFile[];
}

export interface StoredChangeState {
	ref: SessionRef;
	cwd: string;
	baseline: GitReviewSnapshot;
	turns: StoredTurnChangeSet[];
}

export interface ComputedChangeReviewSnapshot {
	snapshotId: string;
	workspaceFingerprint: string;
	unpushed: GitUnpushedReviewSnapshot | null;
	dto: ChangeReviewSnapshot;
	scopes: Record<ChangeReviewScope, ReviewScopeSummary>;
	turns: Array<{ id: string; summary: ReviewScopeSummary }>;
	dynamicDiffs: LRUCache<string, string>;
}

export interface ChangeReviewRuntimeState extends StoredChangeState {
	activeTurn?:
		| {
				id: string;
				startedAt: number;
				beforeHeadSha: string | null;
				userMessageEntryId: string | null;
				shadowCheckpoint: ShadowGitCheckpoint | null;
				tracking: ChangeReviewTrackingState;
				trackedFiles: Map<string, ReviewSnapshotFile>;
				/** Preview remains valid only while the shared watcher clock is unchanged. */
				preview: {
					clock: number;
					files: ReviewSnapshotFile[];
				} | null;
				toolTrackingFailed: boolean;
		  }
		| undefined;
	computed?: ComputedChangeReviewSnapshot | undefined;
	shadow?: ShadowGitSession | undefined;
	watcher?: ProjectFileWatcherLease | undefined;
	liveUpdateTimer?: ReturnType<typeof setTimeout> | undefined;
}
