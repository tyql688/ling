import { activeSkinAppearanceAtom } from "@renderer/lib/appearance/skin-state";
import { useAtomValue } from "jotai";
import { useSmoothMarkdownStream, type SmoothMarkdownStreamOptions } from "markstream-react";
import { useReducedMotion } from "@renderer/hooks/use-reduced-motion";
import { useEffect, useLayoutEffect, useRef } from "react";

/** A short presentation queue absorbs provider bursts without making the reader wait for a
 * fixed typing speed. The controller owns grapheme boundaries and incomplete code fences. */
const STREAM_OPTIONS: SmoothMarkdownStreamOptions = {
	minCharsPerSecond: 50, // Keep a sparse stream moving at a readable pace.
	maxCharsPerSecond: 2_000, // Catch large provider batches up within a short visual tail.
	targetLatencyMs: 180, // Aim for less than a fifth of a second behind incoming content.
	catchUpLatencyMs: 120, // Use a shorter horizon while catching a burst up.
	catchUpThreshold: 160, // Switch to catch-up pacing once a paragraph is queued.
	maxCommitFps: 120, // Let rAF pace 60/120Hz displays; a 60fps time cutoff skips frames on clock jitter.
	startDelayMs: 0, // Never hold the first response just to seed an animation.
	maxCharsPerCommit: 80, // Bound work in each visible text commit.
	flushOnFinish: false,
};

/** At the catch-up speed this keeps a short animated tail after a large provider/tool burst. */
const MAX_ANIMATED_BACKLOG = 640;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** One mounted part owns its presentation queue. Completed history and large restored snapshots
 * start visible; a new short live block reveals its first chunk too. Rewrites replace the snapshot. */
export function useStreamingText(text: string, streaming: boolean, enabled = true) {
	const appearance = useAtomValue(activeSkinAppearanceAtom);
	const reducedMotion = useReducedMotion();
	const animate = enabled && !reducedMotion && appearance.motion !== "none";
	const stream = useSmoothMarkdownStream(STREAM_OPTIONS);
	const { enqueue, finish, flush, getSnapshot, pause, reset, resume } = stream;
	const initialized = useRef(false);
	const initialText = useRef(streaming && text.length <= MAX_ANIMATED_BACKLOG ? "" : text);
	const receivedLiveText = useRef(streaming);

	useLayoutEffect(() => {
		if (!initialized.current) {
			initialized.current = true;
			reset(initialText.current);
		}
		const source = getSnapshot().source;
		if (!animate || document.hidden || !text.startsWith(source)) {
			reset(text);
		} else if (text !== source) {
			if (streaming || receivedLiveText.current) {
				const visibleLength = getSnapshot().visible.length;
				if (text.length - visibleLength > MAX_ANIMATED_BACKLOG) {
					const boundary = graphemes.segment(text).containing(text.length - MAX_ANIMATED_BACKLOG);
					if (!boundary) throw new Error("Missing streaming text grapheme boundary");
					// Advance only the excess prefix. Resetting to the full text made every large burst
					// pop in at once and canceled the animation of thinking and tool output alike.
					if (boundary.index > visibleLength) reset(text.slice(0, boundary.index));
				}
				enqueue(text.slice(getSnapshot().source.length));
			} else reset(text);
		}
		if (streaming) receivedLiveText.current = true;
		else finish();
	}, [animate, enqueue, finish, getSnapshot, reset, streaming, text]);

	useEffect(() => {
		if (!streaming && stream.caughtUp) return;
		const onVisibilityChange = () => {
			if (document.hidden) {
				flush();
				pause();
			} else resume();
		};
		document.addEventListener("visibilitychange", onVisibilityChange);
		return () => document.removeEventListener("visibilitychange", onVisibilityChange);
	}, [flush, pause, resume, stream.caughtUp, streaming]);

	const source = getSnapshot().source;
	const visible =
		animate && text.startsWith(source) ? (initialized.current ? stream.visible : initialText.current) : text;
	return { text: visible, streaming: streaming || visible.length < text.length, animate };
}
