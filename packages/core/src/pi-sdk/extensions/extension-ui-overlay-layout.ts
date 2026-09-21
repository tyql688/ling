import type {
	ExtensionCustomPanelLayout,
	ExtensionOverlayAnchor,
	ExtensionOverlayMargin,
	ExtensionOverlaySizeValue,
} from "@ling/contracts/session-extension-ui";
import { unsupportedExtensionUi as unsupported } from "../../pi-protocol/extension-ui";

/** Off-screen render column width for extension UI; matches common TUI widths, used for panel layout percentage conversion. */
export const EXTENSION_UI_RENDER_WIDTH = 88;
/** Off-screen render row height for extension UI; 24 rows ≈ half a standard terminal screen, used for relative sizes like maxHeight. */
export const EXTENSION_UI_RENDER_ROWS = 24;

export type PiCustomOptions = {
	overlay?: boolean;
	overlayOptions?: unknown;
	onHandle?: (handle: unknown) => void;
};

export interface ExtensionOverlayViewport {
	columns: number;
	rows: number;
}

type PiCustomOverlayOptions = {
	width?: unknown;
	minWidth?: unknown;
	maxHeight?: unknown;
	anchor?: unknown;
	offsetX?: unknown;
	offsetY?: unknown;
	row?: unknown;
	col?: unknown;
	margin?: unknown;
	visible?: unknown;
	nonCapturing?: unknown;
};

/** Default layout for a custom panel when fields are unspecified; centered, zero offset, input-capturing. */
const DEFAULT_CUSTOM_PANEL_LAYOUT: ExtensionCustomPanelLayout = {
	width: null,
	minWidth: null,
	maxHeight: null,
	anchor: "center",
	row: null,
	col: null,
	offsetX: 0,
	offsetY: 0,
	margin: null,
	nonCapturing: false,
};

/** Allowlist of valid overlay anchors; out-of-range values are rejected so layout never lands on unknown coordinates. */
const OVERLAY_ANCHORS = new Set<ExtensionOverlayAnchor>([
	"center",
	"top-left",
	"top-right",
	"bottom-left",
	"bottom-right",
	"top-center",
	"bottom-center",
	"left-center",
	"right-center",
]);

/** Keys allowed in custom overlay options; unknown keys throw unsupported so typos are never silently ignored. */
const CUSTOM_OVERLAY_OPTION_KEYS = new Set([
	"width",
	"minWidth",
	"maxHeight",
	"anchor",
	"offsetX",
	"offsetY",
	"row",
	"col",
	"margin",
	"visible",
	"nonCapturing",
]);

function isOverlaySizeValue(value: unknown): value is ExtensionOverlaySizeValue {
	return typeof value === "number" || (typeof value === "string" && /^\d+(?:\.\d+)?%$/.test(value));
}

function overlayPercent(value: string): number {
	return Number.parseFloat(value.slice(0, -1));
}

function normalizeOverlaySizeValue(capability: string, value: unknown): ExtensionOverlaySizeValue | null {
	if (value === undefined) return null;
	if (!isOverlaySizeValue(value)) unsupported(capability);
	if (typeof value === "number" && (!Number.isFinite(value) || value <= 0)) unsupported(capability);
	return value;
}

function resolveRenderWidth(width: ExtensionOverlaySizeValue | null, viewport?: ExtensionOverlayViewport): number {
	if (typeof width === "number") return Math.floor(width);
	if (typeof width === "string" && viewport !== undefined) {
		return Math.max(1, Math.floor((viewport.columns * overlayPercent(width)) / 100));
	}
	return EXTENSION_UI_RENDER_WIDTH;
}

function resolveRenderRows(maxHeight: ExtensionOverlaySizeValue | null, viewport?: ExtensionOverlayViewport): number {
	if (typeof maxHeight === "number") return Math.floor(maxHeight);
	if (typeof maxHeight === "string" && viewport !== undefined) {
		return Math.max(1, Math.floor((viewport.rows * overlayPercent(maxHeight)) / 100));
	}
	return viewport === undefined ? EXTENSION_UI_RENDER_ROWS : viewport.rows;
}

function normalizeOverlayMargin(value: unknown): ExtensionOverlayMargin | null {
	if (value === undefined) return null;
	if (typeof value === "number") {
		if (!Number.isFinite(value) || value < 0) unsupported("custom.overlayOptions.margin");
		return { top: value, right: value, bottom: value, left: value };
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) unsupported("custom.overlayOptions.margin");
	const raw = value as Record<string, unknown>;
	const side = (name: keyof ExtensionOverlayMargin): number => {
		const sideValue = raw[name];
		if (sideValue === undefined) return 0;
		if (typeof sideValue !== "number" || !Number.isFinite(sideValue) || sideValue < 0) {
			unsupported(`custom.overlayOptions.margin.${name}`);
		}
		return sideValue;
	};
	return { top: side("top"), right: side("right"), bottom: side("bottom"), left: side("left") };
}

function resolveCustomOverlayOptions(options: PiCustomOptions | undefined): PiCustomOverlayOptions | undefined {
	const overlayOptions = options?.overlayOptions;
	if (overlayOptions === undefined) return undefined;
	const resolved = typeof overlayOptions === "function" ? (overlayOptions as () => unknown)() : overlayOptions;
	if (typeof resolved !== "object" || resolved === null || Array.isArray(resolved)) {
		unsupported("custom.overlayOptions");
	}
	return resolved;
}

export function normalizeCustomOverlayLayout(
	options: PiCustomOptions | undefined,
	viewport?: ExtensionOverlayViewport,
): {
	layout: ExtensionCustomPanelLayout;
	renderWidth: number;
	renderRows: number;
	visible: boolean;
} {
	const overlayOptions = resolveCustomOverlayOptions(options);
	if (!overlayOptions) {
		return {
			layout: DEFAULT_CUSTOM_PANEL_LAYOUT,
			renderWidth: EXTENSION_UI_RENDER_WIDTH,
			renderRows: viewport === undefined ? EXTENSION_UI_RENDER_ROWS : viewport.rows,
			visible: true,
		};
	}
	for (const key of Object.keys(overlayOptions)) {
		if (!CUSTOM_OVERLAY_OPTION_KEYS.has(key)) unsupported(`custom.overlayOptions.${key}`);
	}
	if (overlayOptions.visible !== undefined && typeof overlayOptions.visible !== "function") {
		unsupported("custom.overlayOptions.visible");
	}
	if (overlayOptions.nonCapturing !== undefined && typeof overlayOptions.nonCapturing !== "boolean") {
		unsupported("custom.overlayOptions.nonCapturing");
	}
	if (
		overlayOptions.offsetX !== undefined &&
		(typeof overlayOptions.offsetX !== "number" || !Number.isFinite(overlayOptions.offsetX))
	) {
		unsupported("custom.overlayOptions.offsetX");
	}
	if (
		overlayOptions.offsetY !== undefined &&
		(typeof overlayOptions.offsetY !== "number" || !Number.isFinite(overlayOptions.offsetY))
	) {
		unsupported("custom.overlayOptions.offsetY");
	}

	const width = normalizeOverlaySizeValue("custom.overlayOptions.width", overlayOptions.width);
	const maxHeight = normalizeOverlaySizeValue("custom.overlayOptions.maxHeight", overlayOptions.maxHeight);
	const row = normalizeOverlaySizeValue("custom.overlayOptions.row", overlayOptions.row);
	const col = normalizeOverlaySizeValue("custom.overlayOptions.col", overlayOptions.col);
	if (
		overlayOptions.minWidth !== undefined &&
		(typeof overlayOptions.minWidth !== "number" ||
			!Number.isFinite(overlayOptions.minWidth) ||
			overlayOptions.minWidth <= 0)
	) {
		unsupported("custom.overlayOptions.minWidth");
	}
	if (overlayOptions.anchor !== undefined && !OVERLAY_ANCHORS.has(overlayOptions.anchor as ExtensionOverlayAnchor)) {
		unsupported("custom.overlayOptions.anchor");
	}
	const minWidth = typeof overlayOptions.minWidth === "number" ? overlayOptions.minWidth : null;
	const layout: ExtensionCustomPanelLayout = {
		width,
		minWidth,
		maxHeight,
		anchor: (overlayOptions.anchor as ExtensionOverlayAnchor | undefined) ?? "center",
		row,
		col,
		offsetX: overlayOptions.offsetX === undefined ? 0 : overlayOptions.offsetX,
		offsetY: overlayOptions.offsetY === undefined ? 0 : overlayOptions.offsetY,
		margin: normalizeOverlayMargin(overlayOptions.margin),
		nonCapturing: overlayOptions.nonCapturing === true,
	};
	const visible =
		overlayOptions.visible === undefined
			? true
			: viewport !== undefined && overlayOptions.visible(viewport.columns, viewport.rows) === true;
	return {
		layout,
		renderWidth: resolveRenderWidth(width, viewport),
		renderRows: resolveRenderRows(maxHeight, viewport),
		visible,
	};
}
