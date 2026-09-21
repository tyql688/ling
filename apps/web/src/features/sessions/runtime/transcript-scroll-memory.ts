interface MarkdownScrollAnchor {
	/** A row can contain separate thinking, tool, and answer Markdown surfaces. */
	markdownIndex: number;
	nodeIndex: string;
	offsetPx: number;
}

export interface SessionScrollMemory {
	/** scrollTop when leaving (for diagnostics / close-range absolute restore). */
	scrollTop: number;
	/** scrollHeight when leaving, used for clamp/proportional fallback when the content grows taller. */
	scrollHeight: number;
	clientHeight: number;
	/**
	 * Fraction [0,1] within the scrollable range when leaving. Fallback when the anchor row
	 * no longer exists; anchorRowId is preferred because it survives content-height changes.
	 */
	scrollFraction: number;
	/**
	 * Timeline row id (`data-timeline-row`) near the viewport top when leaving.
	 * Restore pins that row — more resilient to content-height changes than absolute px / fraction.
	 */
	anchorRowId: string | null;
	/** Offset (px) of the viewport top relative to the anchor row top; positive means the row top is above the viewport. */
	anchorOffsetPx: number;
	/** Preserve the reading position inside a long message as diagrams above it finish laying out. */
	anchorBlock: MarkdownScrollAnchor | null;
	/** Whether it was at the bottom when leaving (when back at bottom it still follows the stream). */
	atBottom: boolean;
	savedAt: number;
}

/** Active pin: keep a row at a fixed viewport inset across a layout-changing render. */
export interface TranscriptViewportPin {
	rowId: string;
	offsetPx: number;
}

/** Max number of sessions whose scroll positions are remembered; LRU trim prevents unbounded growth. */
const MAX_SESSIONS = 80;
/** Distance from the bottom (px) that counts as "at bottom". */
const SCROLL_AT_BOTTOM_TOLERANCE_PX = 8;

const memory = new Map<string, SessionScrollMemory>();

function touchMemory(key: string, entry: SessionScrollMemory): void {
	memory.delete(key);
	memory.set(key, entry);
	while (memory.size > MAX_SESSIONS) {
		const oldest = memory.keys().next().value;
		if (oldest === undefined) break;
		memory.delete(oldest);
	}
}

export function isScrollAtBottom(element: HTMLElement, tolerancePx = SCROLL_AT_BOTTOM_TOLERANCE_PX): boolean {
	const maxScroll = Math.max(0, element.scrollHeight - element.clientHeight);
	return element.scrollTop >= maxScroll - tolerancePx;
}

/** Capture the first timeline row intersecting the viewport top. */
export function captureTimelineScrollAnchor(scroller: HTMLElement): {
	anchorRowId: string | null;
	anchorOffsetPx: number;
	anchorBlock: MarkdownScrollAnchor | null;
} {
	const scrollerTop = scroller.getBoundingClientRect().top;
	const rows = scroller.querySelectorAll<HTMLElement>("[data-timeline-row]");
	for (const row of rows) {
		const rect = row.getBoundingClientRect();
		if (rect.bottom <= scrollerTop + 1) continue;
		const id = row.dataset.timelineRow;
		if (id === undefined || id.length === 0) continue;
		let anchorBlock: MarkdownScrollAnchor | null = null;
		const markdowns = row.querySelectorAll<HTMLElement>(".chat-markdown");
		for (const [markdownIndex, markdown] of markdowns.entries()) {
			// Markstream keeps its top-level node slots stable across lazy diagram/code rendering.
			for (const block of markdown.querySelectorAll<HTMLElement>(":scope > .markstream-react > [data-node-index]")) {
				const blockRect = block.getBoundingClientRect();
				if (blockRect.height === 0 || blockRect.bottom <= scrollerTop + 1) continue;
				const nodeIndex = block.dataset.nodeIndex;
				if (nodeIndex === undefined) continue;
				anchorBlock = { markdownIndex, nodeIndex, offsetPx: scrollerTop - blockRect.top };
				break;
			}
			if (anchorBlock !== null) break;
		}
		return { anchorRowId: id, anchorOffsetPx: scrollerTop - rect.top, anchorBlock };
	}
	return { anchorRowId: null, anchorOffsetPx: 0, anchorBlock: null };
}

/** Pin scroll so `anchorRowId` stays at the same viewport offset. */
function resolveAnchorScrollTop(
	scroller: HTMLElement,
	anchorRowId: string,
	anchorOffsetPx: number,
	anchorBlock: MarkdownScrollAnchor | null = null,
): number | null {
	for (const row of scroller.querySelectorAll<HTMLElement>("[data-timeline-row]")) {
		if (row.dataset.timelineRow === anchorRowId) {
			if (anchorBlock !== null) {
				const markdown = row.querySelectorAll<HTMLElement>(".chat-markdown")[anchorBlock.markdownIndex];
				const block = markdown?.querySelector<HTMLElement>(
					`:scope > .markstream-react > [data-node-index="${CSS.escape(anchorBlock.nodeIndex)}"]`,
				);
				if (block) {
					return Math.max(
						0,
						block.getBoundingClientRect().top -
							scroller.getBoundingClientRect().top +
							scroller.scrollTop +
							anchorBlock.offsetPx,
					);
				}
			}
			const rowTop = row.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
			return Math.max(0, rowTop + anchorOffsetPx);
		}
	}
	return null;
}

type SessionScrollMemoryInput = Omit<
	SessionScrollMemory,
	"savedAt" | "scrollFraction" | "anchorRowId" | "anchorOffsetPx" | "anchorBlock"
> & {
	scrollFraction?: number;
	anchorRowId?: string | null;
	anchorOffsetPx?: number;
	anchorBlock?: MarkdownScrollAnchor | null;
};

function normalizeSnapshot(snapshot: SessionScrollMemoryInput): Omit<SessionScrollMemory, "savedAt"> {
	const prevMax = Math.max(0, snapshot.scrollHeight - snapshot.clientHeight);
	const scrollFraction =
		typeof snapshot.scrollFraction === "number" && Number.isFinite(snapshot.scrollFraction)
			? Math.min(1, Math.max(0, snapshot.scrollFraction))
			: prevMax <= 0
				? 0
				: Math.min(1, Math.max(0, snapshot.scrollTop / prevMax));
	return {
		scrollTop: snapshot.scrollTop,
		scrollHeight: snapshot.scrollHeight,
		clientHeight: snapshot.clientHeight,
		scrollFraction,
		anchorRowId: snapshot.anchorRowId ?? null,
		anchorOffsetPx: typeof snapshot.anchorOffsetPx === "number" ? snapshot.anchorOffsetPx : 0,
		// Non-Markdown rows and older snapshots legitimately have no block anchor.
		anchorBlock: snapshot.anchorBlock ?? null,
		atBottom: snapshot.atBottom,
	};
}

/** Persist a previously captured metrics snapshot (unmount-safe when the scroller ref is already null). */
export function saveSessionScrollMemorySnapshot(sessionKey: string, snapshot: SessionScrollMemoryInput): void {
	if (sessionKey.length === 0) return;
	touchMemory(sessionKey, { ...normalizeSnapshot(snapshot), savedAt: Date.now() });
}

export function peekSessionScrollMemory(sessionKey: string): SessionScrollMemory | null {
	return memory.get(sessionKey) ?? null;
}

export function forgetSessionScrollMemory(sessionKeys: readonly string[]): void {
	for (const key of sessionKeys) {
		memory.delete(key);
	}
}

/**
 * Resolve open-session scrollTop from memory and the fully mounted transcript.
 * - no memory / was at bottom → stick to bottom
 * - has anchor → restore that row
 * - otherwise → scrollFraction
 */
export function resolveScrollTarget(saved: SessionScrollMemory | null, scroller: HTMLElement): number {
	const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
	if (saved === null || saved.atBottom) {
		return maxScroll;
	}

	const normalized = normalizeSnapshot(saved);
	if (normalized.anchorRowId !== null) {
		const anchored = resolveAnchorScrollTop(
			scroller,
			normalized.anchorRowId,
			normalized.anchorOffsetPx,
			normalized.anchorBlock,
		);
		if (anchored !== null) return Math.min(maxScroll, Math.round(anchored));
	}

	return Math.round(normalized.scrollFraction * maxScroll);
}

/** Recompute absolute scrollTop for an active viewport pin. */
export function resolvePinnedScrollTop(scroller: HTMLElement, pin: TranscriptViewportPin): number | null {
	return resolveAnchorScrollTop(scroller, pin.rowId, pin.offsetPx);
}
