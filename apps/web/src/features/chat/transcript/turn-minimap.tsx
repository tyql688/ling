import { cn } from "@renderer/lib/utils";
import {
	type MouseEvent as ReactMouseEvent,
	type WheelEvent as ReactWheelEvent,
	useLayoutEffect,
	useMemo,
	useState,
} from "react";
import { useStickToBottomContext } from "use-stick-to-bottom";
import type { TurnOutlineEntry } from "./transcript-outline";
import { currentTickFromOffsets, sampleOutline } from "./transcript-outline";
import { ANCHOR_SCROLL_MARGIN_PX } from "./transcript-scroll-policy";
import type { TranscriptVirtualLayout } from "./transcript-virtual-layout";

/** Bound navigation work in long sessions; actual density follows the available height. */
const MAX_TICKS = 24;

/**
 * Right-edge conversation outline: a quiet rail with one marker per sampled user turn.
 * The current scroll position is always legible, hover previews the question and reply,
 * and only a real click jumps.
 */
export function TurnMinimap({
	outline,
	layout,
}: {
	outline: readonly TurnOutlineEntry[];
	layout: TranscriptVirtualLayout;
}) {
	const { scrollRef, stopScroll } = useStickToBottomContext();
	const [bounds, setBounds] = useState({ footerHeight: 0, tickLimit: 0 });
	useLayoutEffect(() => {
		const scroller = scrollRef.current;
		if (!scroller) return;
		const coarsePointer = window.matchMedia("(pointer: coarse)");
		const footer = scroller.querySelector<HTMLElement>("[data-timeline-footer]");
		const measure = () => {
			const footerHeight = footer?.offsetHeight ?? 0;
			const readingHeight = Math.max(0, scroller.clientHeight - footerHeight);
			const targetHeight = coarsePointer.matches ? 44 : 24;
			// Leave breathing room above and below the outline and preserve real hit targets.
			const tickLimit = Math.min(MAX_TICKS, Math.floor((readingHeight * 0.65) / targetHeight));
			setBounds((current) =>
				current.footerHeight === footerHeight && current.tickLimit === tickLimit
					? current
					: { footerHeight, tickLimit },
			);
		};
		const observer = new ResizeObserver(measure);
		observer.observe(scroller);
		if (footer) observer.observe(footer);
		coarsePointer.addEventListener("change", measure);
		measure();
		return () => {
			observer.disconnect();
			coarsePointer.removeEventListener("change", measure);
		};
	}, [scrollRef]);
	const turns = useMemo(() => sampleOutline(outline, Math.max(2, bounds.tickLimit)), [outline, bounds.tickLimit]);
	const [active, setActive] = useState(0);
	const [hovered, setHovered] = useState<number | null>(null);

	// Scroll tracking is rAF-throttled so streaming layout shifts do not create a state update storm.
	useLayoutEffect(() => {
		if (turns.length < 2) return;
		const scroller = scrollRef.current;
		if (!scroller) return;
		let frame = 0;
		const update = () => {
			frame = 0;
			setActive(currentTickFromOffsets(layout.turnOffsets(turns), scroller.scrollTop));
		};
		const onScroll = () => {
			if (frame === 0) frame = requestAnimationFrame(update);
		};
		setActive(currentTickFromOffsets(layout.turnOffsets(turns), scroller.scrollTop));
		scroller.addEventListener("scroll", onScroll, { passive: true });
		const unsubscribe = layout.subscribe(onScroll);
		return () => {
			scroller.removeEventListener("scroll", onScroll);
			unsubscribe();
			if (frame !== 0) cancelAnimationFrame(frame);
		};
	}, [layout, scrollRef, turns]);

	if (turns.length < 2 || bounds.tickLimit < 2) return null;

	const jumpTo = (ordinal: number) => {
		setHovered(null);
		// Leave bottom lock before the virtualizer mounts and refines the exact target row.
		stopScroll();
		layout.jumpToTurn(ordinal, ANCHOR_SCROLL_MARGIN_PX);
	};
	const activateTurn = (event: ReactMouseEvent<HTMLElement>, ordinal: number) => {
		jumpTo(ordinal);
		// Pointer clicks focus native buttons, which would leave focus-within styling active
		// after the pointer leaves. Keyboard activation has detail=0 and keeps its focus background.
		if (event.detail === 0) return;
		const focused = document.activeElement;
		if (focused instanceof HTMLElement && focused.closest("[data-turn-minimap]")) focused.blur();
	};
	const forwardWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
		const scroller = scrollRef.current;
		if (!scroller) return;
		// The rail overlays the scrollport as its sibling, so native wheel targeting cannot
		// reach it. Cancel any page fallback and forward exactly one delta to the transcript.
		event.preventDefault();
		if (event.deltaY < 0) stopScroll();
		scroller.scrollTop += event.deltaY;
	};

	return (
		<div
			data-turn-minimap=""
			style={{ bottom: bounds.footerHeight }}
			className="pointer-events-none absolute top-0 right-0 z-10 flex flex-col justify-center"
		>
			<div
				className="pointer-events-auto relative flex flex-col opacity-60 transition-opacity hover:opacity-100 focus-within:opacity-100"
				onWheel={forwardWheel}
			>
				{turns.map((turn, index) => {
					const isActive = index === active;
					// Clamp the preview card so ticks near the strip's ends don't overflow the viewport.
					const vertical =
						index < turns.length / 3
							? "top-0"
							: index >= (turns.length * 2) / 3
								? "bottom-0"
								: "top-1/2 -translate-y-1/2";
					return (
						// Hover state lives on the ROW (button + card are its DOM descendants), so
						// moving the pointer from the tick onto the card never fires a leave — putting
						// leave on the button unmounts the card before the pointer can reach it.

						<div
							key={turn.ordinal}
							className="group/tick relative"
							onMouseEnter={() => setHovered(index)}
							onMouseLeave={() => setHovered(null)}
							onFocus={() => setHovered(index)}
							onBlur={() => setHovered(null)}
						>
							<button
								type="button"
								aria-label={turn.userText || `#${turn.ordinal + 1}`}
								onClick={(event) => activateTurn(event, turn.ordinal)}
								aria-current={isActive ? "location" : undefined}
								className="relative flex size-6 items-center justify-center rounded-sm pointer-coarse:size-11"
							>
								<span
									className={cn(
										"block h-0.5 rounded-sm transition-transform duration-150 motion-reduce:transition-none",
										isActive
											? "w-3.5 bg-text-primary"
											: "w-2 bg-text-muted/45 group-hover/tick:scale-x-125 group-hover/tick:bg-text-primary/70 group-focus-within/tick:scale-x-125 group-focus-within/tick:bg-text-primary/70",
									)}
								/>
							</button>
							{hovered === index && (
								// eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events -- convenience surface; keyboard users activate the tick button itself (Enter/Space)
								<div
									className={cn("absolute right-full z-20 w-[min(20rem,calc(100vw_-_3rem))] pr-1", vertical)}
									onClick={(event) => activateTurn(event, turn.ordinal)}
								>
									<div className="glass-surface floating-surface cursor-default rounded-menu border border-border-subtle bg-popover p-2.5 shadow-(--shadow-floating)">
										<p className="line-clamp-2 text-xs font-medium text-text-primary">{turn.userText || "…"}</p>
										{turn.replyText && <p className="mt-1 line-clamp-3 text-xs text-text-muted">{turn.replyText}</p>}
									</div>
								</div>
							)}
						</div>
					);
				})}
			</div>
		</div>
	);
}
