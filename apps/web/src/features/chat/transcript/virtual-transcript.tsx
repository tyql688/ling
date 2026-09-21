import { transcriptRowId } from "@renderer/features/chat/transcript/transcript-row-metrics";
import type { TranscriptRow } from "@renderer/features/chat/transcript/transcript-row-model";
import { measureElement as measureVirtualElement, useVirtualizer } from "@tanstack/react-virtual";
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useStickToBottomContext } from "use-stick-to-bottom";
import type { TranscriptVirtualLayout } from "./transcript-virtual-layout";

/** Row spacing matches the timeline's former `gap-5`; keeping it in the layout model makes
 * estimated offsets and measured DOM positions use the same geometry. */
const TIMELINE_ROW_GAP_PX = 20;
/** Six rows covers roughly one viewport above and below on ordinary prose turns without
 * mounting hundreds of Markdown trees during a fast scroll. */
const TRANSCRIPT_OVERSCAN_ROWS = 6;
/** Conservative first measurement for prose/tool rows; ResizeObserver replaces it with the
 * exact height as soon as a row enters the overscan window. */
const DEFAULT_ROW_ESTIMATE_PX = 112;
/** Dividers and change pills are one compact line, so a prose-sized estimate would distort
 * the minimap until they have been visited. */
const COMPACT_ROW_ESTIMATE_PX = 44;
/** Retain measurements for the most recently visited sessions so switching back restores the
 * same virtual geometry before any rows remount. */
const MAX_MEASUREMENT_CACHE_SESSIONS = 24;
/** Ignore subpixel measurement noise so scroll-margin updates converge before restoration. */
const SCROLL_MARGIN_TOLERANCE_PX = 0.5;
/** Two matching frames let the virtualizer and bottom-follow observer finish their initial
 * corrections before exposing the transcript. Hidden rows still keep their full geometry. */
const INITIAL_LAYOUT_STABLE_FRAMES = 2;
/** A live turn can resize continuously; cap the first-paint wait at a quarter second so
 * ongoing output cannot keep the transcript hidden. */
const MAX_INITIAL_LAYOUT_WAIT_MS = 250;
const measurementCaches = new Map<string, Map<string, number>>();

function sessionMeasurementCache(sessionKey: string): Map<string, number> {
	const existing = measurementCaches.get(sessionKey);
	if (existing) {
		measurementCaches.delete(sessionKey);
		measurementCaches.set(sessionKey, existing);
		return existing;
	}
	const created = new Map<string, number>();
	measurementCaches.set(sessionKey, created);
	while (measurementCaches.size > MAX_MEASUREMENT_CACHE_SESSIONS) {
		const oldest = measurementCaches.keys().next().value;
		if (oldest === undefined) break;
		measurementCaches.delete(oldest);
	}
	return created;
}

function estimateTranscriptRow(row: TranscriptRow | undefined): number {
	if (row?.kind === "turnFold" || row?.kind === "turnChanges") return COMPACT_ROW_ESTIMATE_PX;
	if (row?.kind === "plain" && (row.message.role === "compactionSummary" || row.message.role === "modelChange")) {
		return COMPACT_ROW_ESTIMATE_PX;
	}
	return DEFAULT_ROW_ESTIMATE_PX;
}

function elementOffset(scroller: HTMLElement, element: HTMLElement): number {
	return element.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
}

/** The virtualizer compensates `scrollTop` for a row that grows above the viewport, but it issues
 * that scroll before writing the new total size. Growing the sized container first keeps the
 * browser from clamping the compensation to the old maximum, which would shift every following
 * row by the growth until a later frame corrected it. */
function growVirtualContainer(container: HTMLDivElement | null, growth: number): void {
	if (!container || growth <= 0) return;
	const height = Number.parseFloat(container.style.height);
	if (Number.isFinite(height)) container.style.height = `${height + growth}px`;
}

export function VirtualTranscriptRows({
	sessionKey,
	initialScrollTop,
	onLayoutReady,
	rows,
	tailRows,
	layout,
	renderRow,
}: {
	sessionKey: string;
	initialScrollTop: number;
	onLayoutReady: (scroller: HTMLElement) => void;
	rows: readonly TranscriptRow[];
	tailRows: readonly TranscriptRow[];
	layout: TranscriptVirtualLayout;
	renderRow: (row: TranscriptRow) => ReactNode;
}) {
	const { scrollRef } = useStickToBottomContext();
	const listRef = useRef<HTMLDivElement | null>(null);
	const containerRef = useRef<HTMLDivElement | null>(null);
	const rowsRef = useRef(rows);
	rowsRef.current = rows;
	const measurements = useMemo(() => sessionMeasurementCache(sessionKey), [sessionKey]);
	const [scrollMargin, setScrollMargin] = useState(0);
	const [initialLayoutReady, setInitialLayoutReady] = useState(false);
	const initialLayoutDeadlineRef = useRef<number | null>(null);
	const getItemKey = useCallback((index: number) => {
		const row = rowsRef.current[index];
		return row === undefined ? index : transcriptRowId(row);
	}, []);
	const virtualizer = useVirtualizer<HTMLElement, HTMLDivElement>({
		count: rows.length,
		getScrollElement: () => scrollRef.current,
		initialOffset: initialScrollTop,
		getItemKey,
		estimateSize: (index) => {
			const row = rowsRef.current[index];
			return row === undefined
				? DEFAULT_ROW_ESTIMATE_PX
				: (measurements.get(transcriptRowId(row)) ?? estimateTranscriptRow(row));
		},
		measureElement: (element, entry, instance) => {
			const size = measureVirtualElement(element, entry, instance);
			const row = rowsRef.current[instance.indexFromElement(element)];
			if (row) {
				const rowId = transcriptRowId(row);
				growVirtualContainer(containerRef.current, size - (measurements.get(rowId) ?? estimateTranscriptRow(row)));
				measurements.set(rowId, size);
			}
			return size;
		},
		onChange: () => layout.notify(),
		overscan: TRANSCRIPT_OVERSCAN_ROWS,
		gap: TIMELINE_ROW_GAP_PX,
		scrollMargin,
		directDomUpdates: true,
		directDomUpdatesMode: "transform",
	});

	// Passive attachment runs after the enclosing Content has assigned its scroll ref.
	useEffect(() => {
		const list = listRef.current;
		const scroller = scrollRef.current;
		if (!list || !scroller) return;
		const commitMargin = () => {
			const next = elementOffset(scroller, list);
			setScrollMargin((current) => (Math.abs(current - next) < SCROLL_MARGIN_TOLERANCE_PX ? current : next));
		};
		let frame = 0;
		const scheduleMarginMeasurement = () => {
			if (frame !== 0) return;
			frame = requestAnimationFrame(() => {
				frame = 0;
				commitMargin();
			});
		};
		commitMargin();
		const observer = new ResizeObserver(scheduleMarginMeasurement);
		const parent = list.parentElement;
		if (parent) observer.observe(parent);
		window.addEventListener("resize", scheduleMarginMeasurement);
		return () => {
			window.removeEventListener("resize", scheduleMarginMeasurement);
			observer.disconnect();
			if (frame !== 0) cancelAnimationFrame(frame);
		};
	}, [scrollRef, sessionKey]);

	useLayoutEffect(() => {
		layout.bind(virtualizer, rows);
	}, [layout, rows, scrollMargin, virtualizer]);

	// Rebinding measured rows must not cancel an in-progress anchor correction.
	useLayoutEffect(() => () => layout.clear(virtualizer), [layout, virtualizer]);

	useLayoutEffect(() => {
		if (initialLayoutReady) return;
		const scroller = virtualizer.scrollElement;
		if (!scroller) return;
		const list = listRef.current;
		const margin = list ? elementOffset(scroller, list) : 0;
		if (Math.abs(scrollMargin - margin) >= SCROLL_MARGIN_TOLERANCE_PX) {
			setScrollMargin(margin);
			return;
		}
		// The virtualizer's own layout effect has now synchronized its initial offset and
		// DOM measurements. Restoring earlier would be overwritten by that first sync.
		onLayoutReady(scroller);
		if (initialLayoutDeadlineRef.current === null) {
			initialLayoutDeadlineRef.current = performance.now() + MAX_INITIAL_LAYOUT_WAIT_MS;
		}
		const deadline = initialLayoutDeadlineRef.current;
		let frame = 0;
		let previousGeometry = "";
		let stableFrames = 0;
		const revealWhenSettled = () => {
			frame = 0;
			const geometry = [
				scroller.scrollTop,
				scroller.scrollHeight,
				scroller.clientHeight,
				scroller.clientWidth,
				virtualizer.getTotalSize(),
			].join(":");
			stableFrames = geometry === previousGeometry ? stableFrames + 1 : 0;
			previousGeometry = geometry;
			if (stableFrames >= INITIAL_LAYOUT_STABLE_FRAMES || performance.now() >= deadline) {
				setInitialLayoutReady(true);
				return;
			}
			frame = requestAnimationFrame(revealWhenSettled);
		};
		frame = requestAnimationFrame(revealWhenSettled);
		return () => {
			if (frame !== 0) cancelAnimationFrame(frame);
		};
	}, [initialLayoutReady, onLayoutReady, rows, tailRows, scrollMargin, virtualizer, virtualizer.scrollElement]);

	const attachContainer = useCallback(
		(node: HTMLDivElement | null) => {
			containerRef.current = node;
			virtualizer.containerRef(node);
		},
		[virtualizer],
	);
	const items = virtualizer.getVirtualItems();
	const mountedRows = [
		...items.flatMap((item) => {
			const row = rows[item.index];
			return row ? [{ row, index: item.index }] : [];
		}),
		...tailRows.map((row) => ({ row, index: null })),
	];
	return (
		<div className={initialLayoutReady ? undefined : "invisible"} aria-hidden={!initialLayoutReady}>
			<div ref={listRef} data-virtual-transcript="" className="relative flex w-full flex-col">
				<div ref={attachContainer} aria-hidden />
				{/* One keyed sibling list keeps Markdown, disclosure and editor state alive when
				    a new user turn moves the previous tail into measured history. */}
				{mountedRows.map(({ row, index }, position) => {
					const rowId = transcriptRowId(row);
					return (
						<TranscriptLayoutRow
							key={rowId}
							rowId={rowId}
							index={index}
							measureElement={virtualizer.measureElement}
							gap={rows.length > 0 || position > 0}
						>
							{renderRow(row)}
						</TranscriptLayoutRow>
					);
				})}
			</div>
		</div>
	);
}

function TranscriptLayoutRow({
	rowId,
	index,
	measureElement,
	gap,
	children,
}: {
	rowId: string;
	index: number | null;
	measureElement: (element: HTMLDivElement | null) => void;
	gap: boolean;
	children: ReactNode;
}) {
	const measure = useCallback(
		(element: HTMLDivElement | null) => {
			if (element === null || index !== null) measureElement(element);
		},
		[index, measureElement],
	);
	return (
		<div
			ref={measure}
			data-index={index ?? -1}
			data-timeline-row={rowId}
			// A tree navigation may move history back into the tail. Override the virtualizer's
			// retained transform without invalidating its position cache when that row returns.
			className={index !== null ? "absolute left-0 top-0 w-full" : "w-full transform-none!"}
			style={index === null && gap ? { marginTop: TIMELINE_ROW_GAP_PX } : undefined}
		>
			{children}
		</div>
	);
}
