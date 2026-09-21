import type {
	EditQueuedRequest,
	LingSessionEvent,
	SessionMessage,
	SessionQueue,
	SessionRef,
} from "@ling/contracts/session";
import type { PiDiagnostic } from "@ling/contracts/pi-diagnostic";
import type { ReviewSnapshotFile } from "../change-review/change-review";

export type SessionRuntimeReplacementReason = "new" | "fork" | "switch" | "refresh";
export type SessionRuntimeTranscriptInvalidationReason = "treeNavigation" | "reload";
export type SessionRuntimeTranscriptProjectionReason = "markdownWidth";
export type SessionRuntimeQueueKind = EditQueuedRequest["kind"];

export type SessionRuntimeChangeReviewEvent =
	| {
			type: "changeReviewFileUpdated";
			path: string;
			file: ReviewSnapshotFile | null;
	  }
	| {
			type: "changeReviewTrackingFailed";
			code: "CAPTURE_FAILED" | "DIFF_LIMIT_EXCEEDED" | "TURN_LIMIT_EXCEEDED";
	  };

export type SessionRuntimeEvent = LingSessionEvent | SessionRuntimeChangeReviewEvent;

export interface SessionRuntimeReplacementEvent {
	previousRef: SessionRef;
	nextRef: SessionRef;
	reason: SessionRuntimeReplacementReason;
}

export interface SessionRuntimeReplacementReservation {
	commit(): void | Promise<void>;
	abort(): void | Promise<void>;
}

export type SessionRuntimeReplacementCoordinator = (
	event: SessionRuntimeReplacementEvent,
) => SessionRuntimeReplacementReservation | Promise<SessionRuntimeReplacementReservation>;

export interface SessionRuntimeStateSnapshot {
	busy: boolean;
	queue: SessionQueue;
	diagnostics: PiDiagnostic[];
}

export interface SessionRuntimeSnapshot extends SessionRuntimeStateSnapshot {
	messages: SessionMessage[];
}

export interface SessionRuntimeSummary {
	sessionFilePath: string;
	parentSessionFilePath?: string;
	manualFork?: boolean;
	title: string;
	updatedAt: number;
	messageCount: number;
	preview: string;
	transcriptCacheKey: string | null;
}

export interface SessionRuntimeResourceSnapshot {
	lifecycle: "active" | "replacing" | "disposing" | "disposed";
	replacementListeners: number;
	snapshotChangedListeners: number;
	transcriptInvalidatedListeners: number;
	transcriptProjectionChangedListeners: number;
	lifecycleFailureListeners: number;
	replacementCoordinatorOwned: boolean;
	queueMirrorOwned: boolean;
	extensionUiOwned: boolean;
	runtimeServicesOwned: boolean;
}

export interface SessionCatalogFileFingerprint {
	size: number;
	modifiedAtMs: number;
}

export interface SessionCatalogInfo {
	path: string;
	id: string;
	cwd: string;
	name?: string;
	parentSessionPath?: string;
	manualFork?: boolean;
	createdAt: number;
	modifiedAt: number;
	messageCount: number;
	firstMessage: string;
}

export type SessionCatalogDiscovery =
	| { kind: "cached"; path: string; fingerprint: SessionCatalogFileFingerprint }
	| {
			kind: "loaded";
			path: string;
			info: SessionCatalogInfo;
			fingerprint: SessionCatalogFileFingerprint | null;
	  };
