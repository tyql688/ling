import type { LingApi } from "@ling/contracts/api/ling-api";
import type { SessionRef } from "@ling/contracts/session";
import { EXTENSION_DOCK_LINE_CLASS, readExtensionDockContentWidth } from "./extension-dock-layout";

interface ExtensionViewportMeasurement {
	columns: number;
	rows: number;
	markdownColumns: number;
	dockColumns: number;
}

/** Ten glyphs average subpixel text width without making the temporary probe expensive. */
const CELL_WIDTH_PROBE_TEXT = "0000000000";
/** Keep the measurement probe outside every supported viewport so it cannot cover app content. */
const CELL_PROBE_OFFSCREEN_PX = -9_999;
/** Pi surfaces require at least one row and column; zero would make extension rendering invalid. */
const MIN_VIEWPORT_CELLS = 1;

/** Measures one monospace cell for the given utility classes; the dock draws smaller text than the transcript. */
function measureMonospaceCell(className: string): { charWidth: number; lineHeight: number } | null {
	const probe = document.createElement("span");
	probe.textContent = CELL_WIDTH_PROBE_TEXT;
	probe.className = className;
	probe.style.position = "fixed";
	probe.style.left = `${CELL_PROBE_OFFSCREEN_PX}px`;
	probe.style.top = `${CELL_PROBE_OFFSCREEN_PX}px`;
	probe.style.visibility = "hidden";
	probe.style.whiteSpace = "pre";
	document.body.appendChild(probe);
	const rect = probe.getBoundingClientRect();
	const parsedLineHeight = Number.parseFloat(window.getComputedStyle(probe).lineHeight);
	probe.remove();
	const charWidth = rect.width / CELL_WIDTH_PROBE_TEXT.length;
	const lineHeight = Number.isFinite(parsedLineHeight) && parsedLineHeight > 0 ? parsedLineHeight : rect.height;
	if (!Number.isFinite(charWidth) || charWidth <= 0 || !Number.isFinite(lineHeight) || lineHeight <= 0) return null;
	return { charWidth, lineHeight };
}

export function measureExtensionViewport(): ExtensionViewportMeasurement | null {
	if (typeof document === "undefined") return null;
	const root = document.documentElement;
	if (root.clientWidth <= 0 || root.clientHeight <= 0 || !document.body) return null;
	const cell = measureMonospaceCell("font-mono text-xs leading-relaxed");
	// The dock renders widget lines at text-xs/leading-4, so its column count must be measured
	// in that cell — reusing the transcript's would overstate the columns and clip every line.
	const dockCell = measureMonospaceCell(EXTENSION_DOCK_LINE_CLASS);
	if (!cell || !dockCell) return null;
	const timeline = document.querySelector<HTMLElement>("[data-timeline-rows]");
	const timelineWidth = timeline?.getBoundingClientRect().width;
	const markdownWidth = timelineWidth !== undefined && timelineWidth > 0 ? timelineWidth : root.clientWidth;
	return {
		columns: Math.max(MIN_VIEWPORT_CELLS, Math.floor(root.clientWidth / cell.charWidth)),
		rows: Math.max(MIN_VIEWPORT_CELLS, Math.floor(root.clientHeight / cell.lineHeight)),
		markdownColumns: Math.max(MIN_VIEWPORT_CELLS, Math.floor(markdownWidth / cell.charWidth)),
		// Open docks use their measured panel width; an unmounted dock uses its initial width.
		dockColumns: Math.max(MIN_VIEWPORT_CELLS, Math.floor(readExtensionDockContentWidth() / dockCell.charWidth)),
	};
}

/** Initial transcript projection waits for its real width so Pi does not render a large branch twice. */
export async function synchronizeExtensionViewport(
	api: Pick<LingApi["session"], "updateExtensionUiViewport">,
	ref: SessionRef,
): Promise<void> {
	const viewport = measureExtensionViewport();
	if (viewport === null) throw new Error("The session viewport is not measurable");
	await api.updateExtensionUiViewport({ ref, ...viewport });
}
