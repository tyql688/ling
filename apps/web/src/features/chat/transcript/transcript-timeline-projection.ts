import type { SessionMessage } from "@ling/contracts/session-messages";
import type { ChangeReviewTurn } from "@renderer/features/review/turn-changes-card";
import { consumeUnchangedSessionMessagePrefix } from "@renderer/features/sessions/runtime/session-events";
import { buildTurnOutline, extendTurnOutline, type TurnOutlineEntry } from "./transcript-outline";
import {
	buildResultIndex,
	buildRows,
	type BuildRowsSeed,
	buildRowsSeedFromMessages,
	type TimelineRow,
} from "./transcript-activity-model";
import {
	partitionLiveTranscriptRows,
	type TranscriptRow,
	type TranscriptRowPartition,
	withVisibleModelChanges,
} from "./transcript-row-model";
import { withTurnChangeRows } from "./turn-change-rows";
import { withTurnFolds } from "./turn-folds";

interface TranscriptTimelineProjection extends TranscriptRowPartition {
	/** Full row list (history + live) for rendering and empty checks. */
	transcriptRows: readonly TranscriptRow[];
	/** Settled rows before the latest user turn. These are safe to virtualize because
	 * streaming never moves the visible latest turn between DOM owners. */
	virtualRows: readonly TranscriptRow[];
	/** The latest user turn, including its growing assistant tail, stays in normal flow. */
	tailRows: readonly TranscriptRow[];
	/**
	 * Pre-fold timeline rows used for working-status heuristics.
	 * Live-only updates may omit frozen history here — status only inspects the tail.
	 */
	statusRows: readonly TimelineRow[];
	outline: readonly TurnOutlineEntry[];
}

interface ProjectionCache {
	messages: readonly SessionMessage[];
	busy: boolean;
	reviewTurns: readonly ChangeReviewTurn[];
	expandedFoldKeys: ReadonlySet<string>;
	/** Exclusive end index of the frozen history message prefix while a live turn is open. */
	historyMessageCount: number | null;
	historySeed: BuildRowsSeed;
	historyRows: readonly TranscriptRow[];
	historyOutline: readonly TurnOutlineEntry[];
	virtualRows: readonly TranscriptRow[];
	tailSeedRows: readonly TranscriptRow[];
	projection: TranscriptTimelineProjection;
}

function splitLatestTurn(rows: readonly TranscriptRow[]): {
	virtualRows: readonly TranscriptRow[];
	tailRows: readonly TranscriptRow[];
} {
	for (let index = rows.length - 1; index >= 0; index -= 1) {
		const row = rows[index];
		if (row?.kind !== "plain" || row.message.role !== "user") continue;
		return { virtualRows: rows.slice(0, index), tailRows: rows.slice(index) };
	}
	return { virtualRows: [], tailRows: rows };
}

/**
 * Whether the open agent turn still owns a live tail after the latest user message.
 * Mirrors the assistant half of {@link partitionLiveTranscriptRows} without needing rows
 * (activity-only residual falls through to a full rebuild — rare).
 */
function liveHistoryMessageCount(messages: readonly SessionMessage[], busy: boolean): number | null {
	if (!busy || messages.length === 0) return null;
	let latestUserMessageIndex = -1;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		if (messages[index]?.role === "user") {
			latestUserMessageIndex = index;
			break;
		}
	}
	if (latestUserMessageIndex < 0) return null;
	if (latestUserMessageIndex >= messages.length - 1) return latestUserMessageIndex + 1;

	let latestAssistantAfterUser: Extract<SessionMessage, { role: "assistant" }> | null = null;
	for (let index = messages.length - 1; index > latestUserMessageIndex; index -= 1) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		latestAssistantAfterUser = message;
		break;
	}
	const hasActiveAssistant =
		latestAssistantAfterUser === null ||
		latestAssistantAfterUser.stopReason === undefined ||
		latestAssistantAfterUser.stopReason === "toolUse";
	if (!hasActiveAssistant) return null;
	return latestUserMessageIndex + 1;
}

function foldRows(
	baseRows: readonly TimelineRow[],
	messages: readonly SessionMessage[],
	busy: boolean,
	reviewTurns: readonly ChangeReviewTurn[],
	expandedFoldKeys: ReadonlySet<string>,
): TranscriptRow[] {
	return withTurnFolds(withTurnChangeRows(baseRows, reviewTurns), {
		busy,
		expandedTurnKeys: expandedFoldKeys,
		messages,
	});
}

function buildFullProjection(
	messages: readonly SessionMessage[],
	busy: boolean,
	reviewTurns: readonly ChangeReviewTurn[],
	expandedFoldKeys: ReadonlySet<string>,
): {
	historyMessageCount: number | null;
	historySeed: BuildRowsSeed;
	historyRows: readonly TranscriptRow[];
	historyOutline: readonly TurnOutlineEntry[];
	virtualRows: readonly TranscriptRow[];
	tailSeedRows: readonly TranscriptRow[];
	projection: TranscriptTimelineProjection;
} {
	const resultByCallId = buildResultIndex(messages);
	const baseRows = withVisibleModelChanges(buildRows(messages, resultByCallId, busy), messages);
	const transcriptRows = foldRows(baseRows, messages, busy, reviewTurns, expandedFoldKeys);
	const partition = partitionLiveTranscriptRows(transcriptRows, messages, busy);
	const displayPartition = splitLatestTurn(transcriptRows);
	const historyMessageCount = liveHistoryMessageCount(messages, busy);
	const historyMessages = historyMessageCount === null ? messages : messages.slice(0, historyMessageCount);
	const outline = buildTurnOutline(messages);
	const tailSeedRows = partition.historyRows.slice(displayPartition.virtualRows.length);
	return {
		historyMessageCount,
		historySeed: buildRowsSeedFromMessages(historyMessages),
		historyRows: partition.historyRows,
		historyOutline: buildTurnOutline(historyMessages),
		virtualRows: displayPartition.virtualRows,
		tailSeedRows,
		projection: {
			historyRows: partition.historyRows,
			liveRows: partition.liveRows,
			transcriptRows,
			virtualRows: displayPartition.virtualRows,
			tailRows: displayPartition.tailRows,
			statusRows: baseRows,
			outline,
		},
	};
}

function buildLiveOnlyProjection(
	cache: ProjectionCache,
	messages: readonly SessionMessage[],
	busy: boolean,
	reviewTurns: readonly ChangeReviewTurn[],
	expandedFoldKeys: ReadonlySet<string>,
	historyMessageCount: number,
): TranscriptTimelineProjection {
	const liveMessages = messages.slice(historyMessageCount);
	const resultByCallId = buildResultIndex(messages);
	const liveBase = withVisibleModelChanges(
		buildRows(liveMessages, resultByCallId, busy, {
			indexOffset: historyMessageCount,
			seed: cache.historySeed,
		}),
		messages,
	);
	const liveRows = foldRows(liveBase, messages, busy, reviewTurns, expandedFoldKeys);
	// The settled projection remains referentially stable. Only the small latest-turn tail is
	// assembled per stream batch, so token delivery never copies the full transcript row array.
	const tailRows = liveRows.length === 0 ? cache.tailSeedRows : [...cache.tailSeedRows, ...liveRows];
	return {
		historyRows: cache.historyRows,
		liveRows,
		transcriptRows: cache.projection.transcriptRows,
		virtualRows: cache.virtualRows,
		tailRows,
		statusRows: liveBase,
		outline: extendTurnOutline(cache.historyOutline, liveMessages),
	};
}

interface TranscriptTimelineProjector {
	project(
		messages: readonly SessionMessage[],
		busy: boolean,
		reviewTurns: readonly ChangeReviewTurn[],
		expandedFoldKeys: ReadonlySet<string>,
	): TranscriptTimelineProjection;
}

/** One projector per session; ChatTimeline replaces it explicitly when the active session changes. */
export function createTranscriptTimelineProjector(): TranscriptTimelineProjector {
	let cache: ProjectionCache | null = null;

	return {
		project(messages, busy, reviewTurns, expandedFoldKeys) {
			const historyCount = liveHistoryMessageCount(messages, busy);
			const prefixUnchanged = cache
				? consumeUnchangedSessionMessagePrefix(cache.messages, messages, historyCount ?? 0)
				: false;
			if (
				cache &&
				historyCount !== null &&
				cache.historyMessageCount === historyCount &&
				cache.busy === busy &&
				cache.reviewTurns === reviewTurns &&
				cache.expandedFoldKeys === expandedFoldKeys &&
				prefixUnchanged
			) {
				const projection = buildLiveOnlyProjection(cache, messages, busy, reviewTurns, expandedFoldKeys, historyCount);
				cache = {
					...cache,
					messages,
					projection,
				};
				return projection;
			}

			const built = buildFullProjection(messages, busy, reviewTurns, expandedFoldKeys);
			cache = {
				messages,
				busy,
				reviewTurns,
				expandedFoldKeys,
				historyMessageCount: built.historyMessageCount,
				historySeed: built.historySeed,
				historyRows: built.historyRows,
				historyOutline: built.historyOutline,
				virtualRows: built.virtualRows,
				tailSeedRows: built.tailSeedRows,
				projection: built.projection,
			};
			return built.projection;
		},
	};
}
