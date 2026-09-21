import {
	captureTimelineScrollAnchor,
	isScrollAtBottom,
	resolveScrollTarget,
	type SessionScrollMemory,
} from "@renderer/features/sessions/runtime/transcript-scroll-memory";
import type { ScrollToBottom, StickToBottomState } from "use-stick-to-bottom";
import type { TranscriptVirtualLayout } from "./transcript-virtual-layout";

/** Allow virtual row measurements to settle after the final viewport resize, without idle polling. */
const RESIZE_SETTLE_MS = 120;

/** Tracks one session's reading position and preserves its intent while the scrollport changes size. */
export function createTranscriptScrollTracking({
	scroller,
	interactionRoot,
	layout,
	state,
	scrollToBottom,
}: {
	scroller: HTMLElement;
	interactionRoot: HTMLElement;
	layout: TranscriptVirtualLayout;
	state: StickToBottomState;
	scrollToBottom: ScrollToBottom;
}): () => SessionScrollMemory {
	const hasViewport = () => scroller.isConnected && scroller.clientWidth > 0 && scroller.clientHeight > 0;
	const capture = (): SessionScrollMemory => {
		const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
		return {
			scrollTop: scroller.scrollTop,
			scrollHeight: scroller.scrollHeight,
			clientHeight: scroller.clientHeight,
			scrollFraction: maxScroll <= 0 ? 0 : Math.min(1, Math.max(0, scroller.scrollTop / maxScroll)),
			...captureTimelineScrollAnchor(scroller),
			atBottom: isScrollAtBottom(scroller),
			savedAt: Date.now(),
		};
	};
	let snapshot = capture();
	let width = scroller.clientWidth;
	let height = scroller.clientHeight;
	let pin: SessionScrollMemory | null = null;
	let resizing = false;
	let disposed = false;
	let frame = 0;
	let settleTimer: ReturnType<typeof setTimeout> | undefined;

	const correct = () => {
		if (pin === null || !hasViewport()) return;
		if (pin.atBottom) {
			// The library observes content height, not viewport height. Its state setter also
			// marks this scroll as programmatic so row remeasurement cannot escape the lock.
			state.scrollTop = Math.max(0, state.calculatedTargetScrollTop);
			state.escapedFromLock = false;
			if (!state.isAtBottom) void scrollToBottom({ animation: "instant" });
			return;
		}
		// A virtual row may need another layout pass to mount; don't replace its anchor
		// with a proportional estimate while that measurement is pending.
		if (pin.anchorRowId !== null && !scroller.querySelector(`[data-timeline-row="${CSS.escape(pin.anchorRowId)}"]`)) {
			return;
		}
		const target = resolveScrollTarget(pin, scroller);
		// Chromium rounds scrollTop to CSS pixels; subpixel differences need no correction.
		if (Math.abs(scroller.scrollTop - target) >= 1) state.scrollTop = target;
	};
	const finishResize = () => {
		settleTimer = undefined;
		correct();
		snapshot = hasViewport() ? capture() : (pin ?? snapshot);
		pin = null;
		resizing = false;
	};
	const detectResize = () => {
		const nextWidth = scroller.clientWidth;
		const nextHeight = scroller.clientHeight;
		// Hidden workspace surfaces retain their last useful geometry and reading intent.
		if (nextWidth === 0 || nextHeight === 0 || (nextWidth === width && nextHeight === height)) return;
		if (!resizing) {
			pin = { ...snapshot, atBottom: snapshot.atBottom || state.isAtBottom };
			resizing = true;
		}
		width = nextWidth;
		height = nextHeight;
		clearTimeout(settleTimer);
		settleTimer = setTimeout(finishResize, RESIZE_SETTLE_MS);
	};
	const update = () => {
		frame = 0;
		if (disposed || !hasViewport()) return;
		detectResize();
		correct();
		if (!resizing) snapshot = capture();
	};
	const schedule = () => {
		if (!disposed && frame === 0) frame = requestAnimationFrame(update);
	};
	const onResize = () => {
		if (!hasViewport()) return;
		detectResize();
		// scrollTop does not change observed box sizes. Correct before paint while leaving
		// virtualizer and scroll-margin measurement updates in their guarded animation frame.
		correct();
		schedule();
	};
	const onScroll = () => {
		if (!hasViewport()) return;
		detectResize();
		if (pin !== null) state.ignoreScrollToTop = scroller.scrollTop;
		schedule();
	};
	const onInteraction = () => {
		// The wheel, scrollbar, minimap, jump button, and keyboard always take control
		// immediately. A remaining native resize event must not reinstate the old pin.
		pin = null;
		schedule();
	};
	const observer = new ResizeObserver(onResize);
	observer.observe(scroller);
	const content = scroller.firstElementChild;
	if (content) observer.observe(content);
	const unsubscribe = layout.subscribe(schedule);
	scroller.addEventListener("scroll", onScroll, { capture: true, passive: true });
	window.addEventListener("resize", onResize);
	interactionRoot.addEventListener("wheel", onInteraction, { capture: true, passive: true });
	interactionRoot.addEventListener("pointerdown", onInteraction, { capture: true, passive: true });
	interactionRoot.addEventListener("touchstart", onInteraction, { capture: true, passive: true });
	interactionRoot.addEventListener("keydown", onInteraction, true);
	return () => {
		// On unmount the DOM ref may already be detached; the captured snapshot remains
		// authoritative. During a resize, save the pre-resize intent until it has settled.
		if (pin !== null) snapshot = pin;
		else if (hasViewport()) snapshot = capture();
		disposed = true;
		observer.disconnect();
		unsubscribe();
		if (frame !== 0) cancelAnimationFrame(frame);
		clearTimeout(settleTimer);
		scroller.removeEventListener("scroll", onScroll, true);
		window.removeEventListener("resize", onResize);
		interactionRoot.removeEventListener("wheel", onInteraction, true);
		interactionRoot.removeEventListener("pointerdown", onInteraction, true);
		interactionRoot.removeEventListener("touchstart", onInteraction, true);
		interactionRoot.removeEventListener("keydown", onInteraction, true);
		return snapshot;
	};
}
