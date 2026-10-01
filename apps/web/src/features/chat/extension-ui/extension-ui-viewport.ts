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

function createCellProbe(className: string): HTMLSpanElement {
	const probe = document.createElement("span");
	probe.textContent = CELL_WIDTH_PROBE_TEXT;
	probe.className = className;
	probe.style.position = "fixed";
	probe.style.left = `${CELL_PROBE_OFFSCREEN_PX}px`;
	probe.style.top = `${CELL_PROBE_OFFSCREEN_PX}px`;
	probe.style.visibility = "hidden";
	probe.style.whiteSpace = "pre";
	return probe;
}

/** Reads an attached probe without changing the DOM between geometry reads. */
function measureMonospaceCell(probe: HTMLSpanElement): { charWidth: number; lineHeight: number } | null {
	const rect = probe.getBoundingClientRect();
	const parsedLineHeight = Number.parseFloat(window.getComputedStyle(probe).lineHeight);
	const charWidth = rect.width / CELL_WIDTH_PROBE_TEXT.length;
	const lineHeight = Number.isFinite(parsedLineHeight) && parsedLineHeight > 0 ? parsedLineHeight : rect.height;
	if (!Number.isFinite(charWidth) || charWidth <= 0 || !Number.isFinite(lineHeight) || lineHeight <= 0) return null;
	return { charWidth, lineHeight };
}

/** Owns stable font probes so repeated viewport reads do not invalidate page styles. */
export function createExtensionViewportMeasurer() {
	if (typeof document === "undefined") return null;
	const root = document.documentElement;
	if (!document.body) return null;
	const transcriptProbe = createCellProbe("font-mono text-xs leading-relaxed");
	// The dock renders widget lines at text-xs/leading-4, so its column count must be measured
	// in that cell — reusing the transcript's would overstate the columns and clip every line.
	const dockProbe = createCellProbe(EXTENSION_DOCK_LINE_CLASS);
	// Both text styles stay attached while observed, including across font and skin changes.
	document.body.append(transcriptProbe, dockProbe);
	const measure = (): ExtensionViewportMeasurement | null => {
		const width = root.clientWidth;
		const height = root.clientHeight;
		if (width <= 0 || height <= 0) return null;
		const cell = measureMonospaceCell(transcriptProbe);
		const dockCell = measureMonospaceCell(dockProbe);
		if (!cell || !dockCell) return null;
		const timeline = document.querySelector<HTMLElement>("[data-timeline-rows]");
		const timelineWidth = timeline?.getBoundingClientRect().width;
		const markdownWidth = timelineWidth !== undefined && timelineWidth > 0 ? timelineWidth : width;
		return {
			columns: Math.max(MIN_VIEWPORT_CELLS, Math.floor(width / cell.charWidth)),
			rows: Math.max(MIN_VIEWPORT_CELLS, Math.floor(height / cell.lineHeight)),
			markdownColumns: Math.max(MIN_VIEWPORT_CELLS, Math.floor(markdownWidth / cell.charWidth)),
			// Open docks use their measured panel width; an unmounted dock uses its initial width.
			dockColumns: Math.max(MIN_VIEWPORT_CELLS, Math.floor(readExtensionDockContentWidth() / dockCell.charWidth)),
		};
	};
	return {
		measure,
		probes: [transcriptProbe, dockProbe],
		dispose() {
			transcriptProbe.remove();
			dockProbe.remove();
		},
	};
}

/** Initial transcript projection waits for its real width so Pi does not render a large branch twice. */
export async function synchronizeExtensionViewport(
	api: Pick<LingApi["session"], "updateExtensionUiViewport">,
	ref: SessionRef,
): Promise<void> {
	const measurer = createExtensionViewportMeasurer();
	let viewport: ExtensionViewportMeasurement | null;
	try {
		viewport = measurer?.measure() ?? null;
	} finally {
		measurer?.dispose();
	}
	if (viewport === null) throw new Error("The session viewport is not measurable");
	await api.updateExtensionUiViewport({ ref, ...viewport });
}
