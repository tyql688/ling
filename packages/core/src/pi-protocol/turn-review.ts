import type { SessionRef } from "@ling/contracts/session";
import type { ReviewSnapshotFile } from "../change-review/change-review";

export type TurnFileTrackingFailureCode = "CAPTURE_FAILED" | "DIFF_LIMIT_EXCEEDED" | "TURN_LIMIT_EXCEEDED";

export interface PiTurnFallbackCapture {
	files: ReviewSnapshotFile[];
	failureCode: TurnFileTrackingFailureCode | null;
}

export interface PiTurnContext {
	userMessageEntryId: string | null;
}

export interface PiTurnLifecycleHost {
	start(ref: SessionRef, timestamp: number, context: PiTurnContext): Promise<void>;
	finish(ref: SessionRef, timestamp: number, fallback: PiTurnFallbackCapture, context: PiTurnContext): Promise<void>;
}
