import type { SessionMessage } from "@ling/contracts/session-messages";
import { sessionMessageRowIdentity } from "@renderer/features/sessions/runtime/session-message-identity";
import { isResolvedByLaterCompaction } from "./compaction-errors";
import { toolCategoryForName, type TimelineRow } from "./transcript-activity-model";
import type { TranscriptRow, TurnFoldRow } from "./transcript-row-model";

interface TurnFoldOptions {
	/** The running turn is never folded; it settles into a fold once the runtime goes idle. */
	busy: boolean;
	expandedTurnKeys: ReadonlySet<string>;
	messages: readonly SessionMessage[];
}

interface TurnSegment {
	turnKey: string;
	entryId: string | null;
	failure: string | null;
	activity: TurnFoldRow["activity"];
	userTimestamp: number | undefined;
	/** Indices into the source row array, in order. */
	foldableIndexes: number[];
	terminalAssistantIndex: number | null;
	outcome: TurnFoldRow["outcome"];
	endTimestamp: number | undefined;
}

/** Dividers stay visible: they carry context (model switches, compactions) that folding
 * a turn's work must not hide. Turn-change cards are review state rather than process
 * output, so they stay visible as well. */
function isFoldCandidate(row: TranscriptRow): row is TimelineRow {
	if (row.kind === "activity") return true;
	if (row.kind !== "plain") return false;
	const role = row.message.role;
	// Custom messages inside work already belong to an activity row. Standalone extension
	// output stays visible and cannot extend a previous model turn's elapsed time.
	return role === "assistant" || role === "toolResult";
}

function messageTimestamp(message: SessionMessage): number | undefined {
	if (!("timestamp" in message) || typeof message.timestamp !== "number") return undefined;
	return message.timestamp;
}

function rowEndTimestamp(row: TranscriptRow): number | undefined {
	if (row.kind === "activity") return row.endTs ?? row.startTs;
	if (row.kind === "plain") return messageTimestamp(row.message);
	return undefined;
}

function isAbortedAssistant(message: SessionMessage): boolean {
	return message.role === "assistant" && message.stopReason === "aborted";
}

function collectTurnSegments(rows: readonly TranscriptRow[], messages: readonly SessionMessage[]): TurnSegment[] {
	const segments: TurnSegment[] = [];
	let current: TurnSegment | null = null;
	for (const [index, row] of rows.entries()) {
		if (row.kind === "plain" && row.message.role === "user") {
			current = {
				turnKey: sessionMessageRowIdentity(row.message),
				entryId: row.message.entryId,
				failure: null,
				activity: { read: 0, edit: 0, run: 0, other: 0 },
				userTimestamp: messageTimestamp(row.message),
				foldableIndexes: [],
				terminalAssistantIndex: null,
				outcome: "completed",
				endTimestamp: undefined,
			};
			segments.push(current);
			continue;
		}
		if (current === null || !isFoldCandidate(row)) continue;
		current.foldableIndexes.push(index);
		if (row.kind === "activity")
			for (const item of row.items)
				if (item.type === "step") current.activity[toolCategoryForName(item.step.call.name)] += 1;
		const failure = row.kind === "activity" ? row.items.findLast((item) => item.type === "failure") : undefined;
		if (failure && current.terminalAssistantIndex === null) {
			current.failure = failure.message.errorMessage ?? null;
			current.outcome = failure.resolvedByLaterCompaction ? "completed" : "failed";
		}
		if (row.kind === "plain" && row.message.role === "assistant") {
			if (row.message.stopReason === "error") {
				current.failure = row.message.errorMessage ?? null;
				// Provider/tool failures belong to the turn's internal work. Only call the
				// whole turn failed when it never produced a visible assistant response.
				if (current.terminalAssistantIndex === null) {
					current.outcome = isResolvedByLaterCompaction(messages, row.index) ? "completed" : "failed";
				}
			} else {
				current.terminalAssistantIndex = index;
				current.outcome = isAbortedAssistant(row.message) ? "stopped" : "completed";
			}
		}
		const end = rowEndTimestamp(row);
		if (end !== undefined && (current.endTimestamp === undefined || end > current.endTimestamp)) {
			current.endTimestamp = end;
		}
	}
	return segments;
}

function foldDurationMs(segment: TurnSegment): number | null {
	if (segment.userTimestamp === undefined || segment.endTimestamp === undefined) return null;
	return Math.max(0, segment.endTimestamp - segment.userTimestamp);
}

/** Fold settled turns' work rows behind a duration row anchored at the turn's first
 * foldable row; successful terminal responses stay visible while failed terminal
 * messages remain inside the fold. */
export function withTurnFolds(rows: readonly TranscriptRow[], options: TurnFoldOptions): TranscriptRow[] {
	const segments = collectTurnSegments(rows, options.messages);
	if (segments.length === 0) return [...rows];
	const latestSegment = segments.at(-1);

	const foldRowByAnchorIndex = new Map<number, TurnFoldRow>();
	const hiddenIndexes = new Set<number>();
	const expandedActivityIndexes = new Set<number>();
	for (const segment of segments) {
		if (options.busy && segment === latestSegment) continue;
		const hidden = segment.foldableIndexes.filter((index) => index !== segment.terminalAssistantIndex);
		if (hidden.length === 0) continue;
		const anchorIndex = hidden[0];
		if (anchorIndex === undefined) continue;
		const expanded = options.expandedTurnKeys.has(segment.turnKey);
		foldRowByAnchorIndex.set(anchorIndex, {
			kind: "turnFold",
			turnKey: segment.turnKey,
			durationMs: foldDurationMs(segment),
			outcome: segment.outcome,
			expanded,
			hiddenCount: hidden.length,
			failure: segment.outcome === "failed" ? segment.failure : null,
			retryEntryId: segment.outcome === "failed" && segment === latestSegment ? segment.entryId : null,
			activity: segment.activity,
		});
		if (expanded) {
			for (const index of hidden) {
				if (rows[index]?.kind === "activity") expandedActivityIndexes.add(index);
			}
		} else {
			for (const index of hidden) hiddenIndexes.add(index);
		}
	}
	if (foldRowByAnchorIndex.size === 0) return [...rows];

	const next: TranscriptRow[] = [];
	for (const [index, row] of rows.entries()) {
		const fold = foldRowByAnchorIndex.get(index);
		if (fold) next.push(fold);
		if (hiddenIndexes.has(index)) continue;
		next.push(
			expandedActivityIndexes.has(index) && row.kind === "activity" ? { ...row, expandedByTurnFold: true } : row,
		);
	}
	return next;
}
