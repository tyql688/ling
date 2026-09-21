/** Shared top margin for minimap / outline jump targets (keeps the hit below the toolbar). */
export const ANCHOR_SCROLL_MARGIN_PX = 32;

interface TranscriptWheelState {
	deltaY: number;
	scrollHeight: number;
	clientHeight: number;
}

/** A vertical upward wheel gesture always means "let me read above", even when its DOM
 * target is a code/table/formula container that exists only for horizontal overflow. */
export function shouldEscapeTranscriptBottomLock(state: TranscriptWheelState): boolean {
	return state.deltaY < 0 && state.scrollHeight > state.clientHeight;
}

/**
 * After a layout-changing expand/collapse, keep `anchor`'s viewport Y unchanged so content
 * grows or shrinks downward in place instead of jumping the reading position.
 */
export function preserveViewportAnchorTop(scroller: HTMLElement, anchor: HTMLElement, previousTop: number): void {
	scroller.scrollTop += anchor.getBoundingClientRect().top - previousTop;
}
