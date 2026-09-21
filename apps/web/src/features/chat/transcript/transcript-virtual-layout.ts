import { transcriptRowId } from "@renderer/features/chat/transcript/transcript-row-metrics";
import type { TranscriptRow } from "@renderer/features/chat/transcript/transcript-row-model";
import type { Virtualizer } from "@tanstack/react-virtual";
import type { TurnOutlineEntry } from "./transcript-outline";

/** A virtual jump is refined after mounting the target. Four animation frames cover large
 * Markdown/code measurements without leaving an unbounded correction loop. */
const MAX_JUMP_CORRECTION_FRAMES = 4;

type TranscriptVirtualizer = Virtualizer<HTMLElement, HTMLDivElement>;
type LayoutSubscriber = () => void;

function rowOrdinal(row: TranscriptRow): number | null {
	return row.kind === "plain" && row.message.role === "user" ? row.userMessageOrdinal : null;
}

function elementOffset(scroller: HTMLElement, element: HTMLElement): number {
	return element.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
}

function timelineRowElement(scroller: HTMLElement, rowId: string): HTMLElement | null {
	for (const row of scroller.querySelectorAll<HTMLElement>("[data-timeline-row]")) {
		if (row.dataset.timelineRow === rowId) return row;
	}
	return null;
}

function turnElement(scroller: HTMLElement, ordinal: number): HTMLElement | null {
	return scroller.querySelector<HTMLElement>(`[data-turn="${ordinal}"]`);
}

export interface TranscriptVirtualLayout {
	bind(virtualizer: TranscriptVirtualizer, rows: readonly TranscriptRow[]): void;
	clear(virtualizer: TranscriptVirtualizer): void;
	notify(): void;
	subscribe(subscriber: LayoutSubscriber): () => void;
	turnOffsets(turns: readonly TurnOutlineEntry[]): number[];
	jumpToTurn(ordinal: number, topInset: number): boolean;
	jumpToRow(rowId: string, topOffset: number): boolean;
}

class TranscriptVirtualLayoutOwner implements TranscriptVirtualLayout {
	private virtualizer: TranscriptVirtualizer | null = null;
	private readonly rowIndexById = new Map<string, number>();
	private readonly rowIndexByOrdinal = new Map<number, number>();
	private readonly subscribers = new Set<LayoutSubscriber>();
	private correctionFrame = 0;

	bind(virtualizer: TranscriptVirtualizer, rows: readonly TranscriptRow[]): void {
		this.virtualizer = virtualizer;
		this.rowIndexById.clear();
		this.rowIndexByOrdinal.clear();
		rows.forEach((row, index) => {
			this.rowIndexById.set(transcriptRowId(row), index);
			const ordinal = rowOrdinal(row);
			if (ordinal !== null) this.rowIndexByOrdinal.set(ordinal, index);
		});
		this.notify();
	}

	clear(virtualizer: TranscriptVirtualizer): void {
		if (this.virtualizer !== virtualizer) return;
		this.virtualizer = null;
		this.rowIndexById.clear();
		this.rowIndexByOrdinal.clear();
		if (this.correctionFrame !== 0) cancelAnimationFrame(this.correctionFrame);
		this.correctionFrame = 0;
		this.notify();
	}

	notify(): void {
		for (const subscriber of this.subscribers) subscriber();
	}

	subscribe(subscriber: LayoutSubscriber): () => void {
		this.subscribers.add(subscriber);
		return () => this.subscribers.delete(subscriber);
	}

	turnOffsets(turns: readonly TurnOutlineEntry[]): number[] {
		const virtualizer = this.virtualizer;
		const scroller = virtualizer?.scrollElement;
		if (!virtualizer || !scroller) return turns.map(() => Number.POSITIVE_INFINITY);
		return turns.map((turn) => {
			const mounted = turnElement(scroller, turn.ordinal);
			if (mounted) return elementOffset(scroller, mounted);
			const index = this.rowIndexByOrdinal.get(turn.ordinal);
			if (index === undefined) return Number.POSITIVE_INFINITY;
			return virtualizer.measurementsCache[index]?.start ?? Number.POSITIVE_INFINITY;
		});
	}

	jumpToTurn(ordinal: number, topInset: number): boolean {
		const virtualizer = this.virtualizer;
		const scroller = virtualizer?.scrollElement;
		if (!virtualizer || !scroller) return false;
		const mounted = turnElement(scroller, ordinal);
		if (mounted) {
			this.commitScroll(scroller, elementOffset(scroller, mounted) - topInset);
			return true;
		}
		const index = this.rowIndexByOrdinal.get(ordinal);
		if (index === undefined) return false;
		virtualizer.scrollToIndex(index, { align: "start", behavior: "instant" });
		this.refineScroll(scroller, () => turnElement(scroller, ordinal), topInset);
		return true;
	}

	jumpToRow(rowId: string, topOffset: number): boolean {
		const virtualizer = this.virtualizer;
		const scroller = virtualizer?.scrollElement;
		if (!virtualizer || !scroller) return false;
		const mounted = timelineRowElement(scroller, rowId);
		if (mounted) {
			this.commitScroll(scroller, elementOffset(scroller, mounted) + topOffset);
			return true;
		}
		const index = this.rowIndexById.get(rowId);
		if (index === undefined) return false;
		virtualizer.scrollToIndex(index, { align: "start", behavior: "instant" });
		this.refineScroll(scroller, () => timelineRowElement(scroller, rowId), -topOffset);
		return true;
	}

	private commitScroll(scroller: HTMLElement, requested: number): void {
		const maximum = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
		scroller.scrollTop = Math.min(maximum, Math.max(0, requested));
	}

	private refineScroll(scroller: HTMLElement, findTarget: () => HTMLElement | null, topInset: number): void {
		if (this.correctionFrame !== 0) cancelAnimationFrame(this.correctionFrame);
		let attempts = 0;
		const correct = () => {
			this.correctionFrame = 0;
			const target = findTarget();
			if (target) this.commitScroll(scroller, elementOffset(scroller, target) - topInset);
			attempts += 1;
			if (target && attempts >= MAX_JUMP_CORRECTION_FRAMES) return;
			if (attempts < MAX_JUMP_CORRECTION_FRAMES) this.correctionFrame = requestAnimationFrame(correct);
		};
		this.correctionFrame = requestAnimationFrame(correct);
	}
}

export function createTranscriptVirtualLayout(): TranscriptVirtualLayout {
	return new TranscriptVirtualLayoutOwner();
}
