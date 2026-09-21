import {
	resolveScrollTarget,
	type SessionScrollMemory,
} from "@renderer/features/sessions/runtime/transcript-scroll-memory";
import type { TranscriptVirtualLayout } from "./transcript-virtual-layout";

/** Keep a restored reading anchor through asynchronous row measurements until the reader
 * takes control. Resize notifications schedule work; idle sessions never poll. */
export function createTranscriptScrollRestoration({
	scroller,
	interactionRoot,
	layout,
	saved,
}: {
	scroller: HTMLElement;
	interactionRoot: HTMLElement;
	layout: TranscriptVirtualLayout;
	saved: SessionScrollMemory;
}): () => void {
	let disposed = false;
	let frame = 0;
	const correct = () => {
		frame = 0;
		if (disposed || !scroller.isConnected) return;
		// A virtual jump first mounts its target. A proportional fallback here would undo
		// that jump before the row can appear; the next layout notification will retry.
		if (
			saved.anchorRowId !== null &&
			!scroller.querySelector(`[data-timeline-row="${CSS.escape(saved.anchorRowId)}"]`)
		) {
			return;
		}
		const target = resolveScrollTarget(saved, scroller);
		// scrollTop is rounded by Chromium; ignore differences below one CSS pixel.
		if (Math.abs(scroller.scrollTop - target) >= 1) scroller.scrollTop = target;
	};
	const schedule = () => {
		if (!disposed && frame === 0) frame = requestAnimationFrame(correct);
	};
	const observer = new ResizeObserver(schedule);
	observer.observe(scroller);
	const content = scroller.firstElementChild;
	if (content) observer.observe(content);
	const unsubscribe = layout.subscribe(schedule);
	const dispose = () => {
		if (disposed) return;
		disposed = true;
		observer.disconnect();
		unsubscribe();
		if (frame !== 0) cancelAnimationFrame(frame);
		frame = 0;
		interactionRoot.removeEventListener("wheel", dispose, true);
		interactionRoot.removeEventListener("pointerdown", dispose, true);
		interactionRoot.removeEventListener("touchstart", dispose, true);
		interactionRoot.removeEventListener("keydown", dispose, true);
	};
	// Includes the scrollbar, minimap, jump button, and keyboard navigation. Do not fight
	// user input or keep a stale anchor when a disclosure changes the intended view.
	interactionRoot.addEventListener("wheel", dispose, { capture: true, passive: true });
	interactionRoot.addEventListener("pointerdown", dispose, { capture: true, passive: true });
	interactionRoot.addEventListener("touchstart", dispose, { capture: true, passive: true });
	interactionRoot.addEventListener("keydown", dispose, true);
	correct();
	return dispose;
}
