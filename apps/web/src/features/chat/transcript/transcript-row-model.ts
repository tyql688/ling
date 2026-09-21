import type { SessionMessage } from "@ling/contracts/session-messages";
import { visibleModelChangeIndexes } from "./model-change-events";
import type { TimelineRow } from "./transcript-activity-model";

export interface TurnFoldRow {
	kind: "turnFold";
	/** Stable identity of the turn's initiating user message. Loaded-window ordinals
	 * shift when older pages prepend, so they must never key fold state or row ids. */
	turnKey: string;
	durationMs: number | null;
	outcome: "completed" | "stopped" | "failed";
	expanded: boolean;
	hiddenCount: number;
	failure: string | null;
	retryEntryId: string | null;
	activity: Record<"read" | "edit" | "run" | "other", number>;
}

export interface TurnChangesRow {
	kind: "turnChanges";
	turnId: string;
	userMessageEntryId: string;
}

export type TranscriptRow = TimelineRow | TurnFoldRow | TurnChangesRow;

export interface TranscriptRowPartition {
	historyRows: readonly TranscriptRow[];
	liveRows: readonly TranscriptRow[];
}

/** Keep the settled prefix referentially stable while the current assistant turn grows. The
 * user row remains historical; every following activity/text/change row belongs to the live
 * tail until the runtime publishes the completed assistant snapshot. */
export function partitionLiveTranscriptRows(
	rows: readonly TranscriptRow[],
	messages: readonly SessionMessage[],
	busy: boolean,
): TranscriptRowPartition {
	if (!busy || rows.length === 0) return { historyRows: rows, liveRows: [] };

	let liveStartIndex = 0;
	let latestUserMessageIndex = -1;
	for (const [index, row] of rows.entries()) {
		if (row.kind !== "plain" || row.message.role !== "user") continue;
		liveStartIndex = index + 1;
		latestUserMessageIndex = row.index;
	}
	if (latestUserMessageIndex < 0) return { historyRows: rows, liveRows: [] };
	if (liveStartIndex >= rows.length) return { historyRows: rows, liveRows: [] };

	let latestAssistantAfterUser: Extract<SessionMessage, { role: "assistant" }> | null = null;
	for (let index = messages.length - 1; index > latestUserMessageIndex; index -= 1) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		latestAssistantAfterUser = message;
		break;
	}
	const waitingForFirstAssistant = latestUserMessageIndex === messages.length - 1;
	const hasActiveAssistant =
		waitingForFirstAssistant ||
		latestAssistantAfterUser?.stopReason === undefined ||
		latestAssistantAfterUser.stopReason === "toolUse";
	const hasRunningActivity = rows.slice(liveStartIndex).some((row) => row.kind === "activity" && row.running);
	if (!hasActiveAssistant && !hasRunningActivity) return { historyRows: rows, liveRows: [] };

	return {
		historyRows: rows.slice(0, liveStartIndex),
		liveRows: rows.slice(liveStartIndex),
	};
}

export function withVisibleModelChanges(
	rows: readonly TimelineRow[],
	messages: readonly SessionMessage[],
): TimelineRow[] {
	const visibleIndexes = visibleModelChangeIndexes(messages);
	return rows.filter(
		(row) => row.kind !== "plain" || row.message.role !== "modelChange" || visibleIndexes.has(row.index),
	);
}
