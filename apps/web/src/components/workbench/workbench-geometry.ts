/** Version 2 stores right-column width as a ratio of its usable range. Version 1 pixel widths remain valid until the user drags or resets the divider. Ratio-based widths follow window resizing. */
export interface WorkbenchGeometry {
	version: 2;
	/** 0 is the narrowest right column and 1 the widest; null follows the default width. */
	rightRatio: number | null;
	/** Conversation width carried over from version 1 until a ratio replaces it. */
	legacyConversation: number | null;
	/** Docked file tree width. */
	sidebar: number;
	/** The reading pane keeps its size when it trades places with the conversation. */
	readingOnLeft: boolean;
}

export const DEFAULT_GEOMETRY: WorkbenchGeometry = {
	version: 2,
	rightRatio: null,
	legacyConversation: null,
	sidebar: 280,
	readingOnLeft: false,
};

/** The conversation keeps room for its reading column and Composer controls. */
export const MIN_CONVERSATION_WIDTH = 352;
/** The narrowest right column that still fits a tab row and a file list. */
const MIN_RIGHT_WIDTH = 320;
const MAX_LEGACY_CONVERSATION_WIDTH = 1600;
const MIN_SIDEBAR_WIDTH = 240;
const MAX_SIDEBAR_WIDTH = 600;

function sidebarWidth(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= MIN_SIDEBAR_WIDTH && value <= MAX_SIDEBAR_WIDTH
		? value
		: null;
}

/** Validates a stored preference; unknown shapes return null so the default applies. */
export function parseWorkbenchGeometry(value: unknown): WorkbenchGeometry | null {
	if (typeof value !== "object" || value === null || !("version" in value)) return null;
	const record = value as Record<string, unknown>;
	const sidebar = sidebarWidth(record.sidebar);
	if (sidebar === null) return null;
	if (record.version === 1) {
		const conversation = record.conversation;
		return typeof conversation === "number" &&
			Number.isFinite(conversation) &&
			conversation >= 300 &&
			conversation <= MAX_LEGACY_CONVERSATION_WIDTH
			? { version: 2, rightRatio: null, legacyConversation: conversation, sidebar, readingOnLeft: false }
			: null;
	}
	if (record.version !== 2) return null;
	// Version 2 preferences with no pane-order field use conversation-first order.
	const readingOnLeft = record.readingOnLeft === undefined ? false : record.readingOnLeft;
	if (typeof readingOnLeft !== "boolean") return null;
	const ratio = record.rightRatio;
	const legacy = record.legacyConversation;
	const validRatio =
		ratio === null || (typeof ratio === "number" && Number.isFinite(ratio) && ratio >= 0 && ratio <= 1);
	const validLegacy =
		legacy === null ||
		(typeof legacy === "number" && Number.isFinite(legacy) && legacy >= 300 && legacy <= MAX_LEGACY_CONVERSATION_WIDTH);
	return validRatio && validLegacy
		? { version: 2, rightRatio: ratio, legacyConversation: legacy, sidebar, readingOnLeft }
		: null;
}

function rightRange(width: number): { min: number; max: number } {
	const max = Math.max(MIN_RIGHT_WIDTH, width - MIN_CONVERSATION_WIDTH);
	return { min: Math.min(MIN_RIGHT_WIDTH, max), max };
}

/**
 * The default right column leaves the conversation about 500px, is capped at a 16:10 box of the
 * available height so wide screens do not stretch reading lines, and never drops below 640px while
 * the conversation keeps its minimum.
 */
export function defaultRightWidth(width: number, height: number): number {
	return Math.max(MIN_RIGHT_WIDTH, Math.min(height * 1.6, width - 500), Math.min(640, width - MIN_CONVERSATION_WIDTH));
}

/** Right-column width for the current workbench size, clamped so both columns keep their minimum. */
export function rightColumnWidth(geometry: WorkbenchGeometry, width: number, height: number): number {
	const { min, max } = rightRange(width);
	const preferred =
		geometry.rightRatio !== null
			? min + geometry.rightRatio * (max - min)
			: geometry.legacyConversation !== null
				? width - geometry.legacyConversation
				: defaultRightWidth(width, height);
	return Math.round(Math.min(max, Math.max(min, preferred)));
}

/** Stores a dragged right-column width as its position within the usable range. */
export function withRightWidth(geometry: WorkbenchGeometry, rightWidth: number, width: number): WorkbenchGeometry {
	const { min, max } = rightRange(width);
	const ratio = max === min ? 0 : (Math.min(max, Math.max(min, rightWidth)) - min) / (max - min);
	return { ...geometry, rightRatio: Math.round(ratio * 1000) / 1000, legacyConversation: null };
}
