import type { ChangeReviewTurn } from "@renderer/features/review/turn-changes-card";
import type { TranscriptRow, TurnChangesRow } from "./transcript-row-model";

/** Semantic revision for the memoized card row: file, stats, and tracking changes rerender it. */
export function turnChangesRowRevision(turnId: string, turn: ChangeReviewTurn | undefined): string {
	if (!turn) return `turn-changes:${turnId}:missing`;
	const files = turn.summary.files
		.map((file) => `${file.path}:${file.contentTag ?? ""}:${file.additions ?? 0}:${file.deletions ?? 0}`)
		.join(",");
	return `turn-changes:${turnId}:${turn.tracking.status}:${files}`;
}

/** Cards attach after each turn's last response row. Turns without a durable link,
 * without file changes, or still running (no stored summary yet) get no card. */
export function withTurnChangeRows(
	rows: readonly TranscriptRow[],
	turns: readonly ChangeReviewTurn[],
): TranscriptRow[] {
	const turnsByEntryId = new Map<string, ChangeReviewTurn>();
	for (const turn of turns) {
		if (turn.userMessageEntryId !== null && turn.summary.files.length > 0) {
			turnsByEntryId.set(turn.userMessageEntryId, turn);
		}
	}
	if (turnsByEntryId.size === 0) return [...rows];
	// One pass to find each linked segment's insertion point: after the segment's last
	// assistant row, or after its last row when the turn produced no visible response.
	const insertAfterIndex = new Map<number, TurnChangesRow>();
	let currentEntryId: string | null = null;
	let segmentLastIndex = -1;
	let segmentLastAssistantIndex = -1;
	const flushSegment = (): void => {
		if (currentEntryId === null) return;
		const turn = turnsByEntryId.get(currentEntryId);
		if (!turn) return;
		const anchorIndex = segmentLastAssistantIndex >= 0 ? segmentLastAssistantIndex : segmentLastIndex;
		if (anchorIndex < 0) return;
		insertAfterIndex.set(anchorIndex, {
			kind: "turnChanges",
			turnId: turn.id,
			userMessageEntryId: currentEntryId,
		});
	};
	for (const [index, row] of rows.entries()) {
		if (row.kind === "plain" && row.message.role === "user") {
			flushSegment();
			currentEntryId = row.message.entryId ?? null;
			segmentLastIndex = index;
			segmentLastAssistantIndex = -1;
			continue;
		}
		if (currentEntryId === null) continue;
		segmentLastIndex = index;
		if ((row.kind === "plain" && row.message.role === "assistant") || (row.kind === "activity" && row.terminalReply)) {
			segmentLastAssistantIndex = index;
		}
	}
	flushSegment();
	if (insertAfterIndex.size === 0) return [...rows];

	const next: TranscriptRow[] = [];
	for (const [index, row] of rows.entries()) {
		next.push(row);
		const card = insertAfterIndex.get(index);
		if (card) next.push(card);
	}
	return next;
}
