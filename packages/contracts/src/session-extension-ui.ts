import type { McpStatus } from "./mcp";
import type { z } from "zod";
import type * as requestSchemas from "./session-requests";
type RequestSchemasShape = ReturnType<typeof requestSchemas.createSessionRequestSchemas>;

export interface ExtensionWorkingIndicatorSnapshot {
	frames?: string[];
	intervalMs?: number;
}

export type ExtensionUiStateEvent =
	| { type: "status"; key: string; text: string | null }
	| { type: "widget"; key: string; lines: string[]; placement: "aboveComposer" | "belowComposer" | null }
	| { type: "header"; lines: string[] | null }
	| { type: "footer"; lines: string[] | null }
	| { type: "workingMessage"; message: string | null }
	| { type: "workingVisible"; visible: boolean }
	| { type: "workingIndicator"; indicator: ExtensionWorkingIndicatorSnapshot | null }
	| {
			type: "custom";
			lines: string[] | null;
			hidden: boolean;
			focused: boolean;
			layout: ExtensionCustomPanelLayout | null;
	  }
	| { type: "customVisibility"; hidden: boolean; focused: boolean }
	| { type: "title"; title: string | null }
	| { type: "editorText"; text: string }
	| { type: "voiceSettings"; requestId: string }
	| { type: "mcpSettings"; requestId: string }
	| { type: "mcpStatus"; value: McpStatus | null }
	| { type: "terminalInputListening"; listening: boolean }
	| { type: "toolsExpanded"; expanded: boolean }
	| { type: "hiddenThinkingLabel"; label: string | null }
	| { type: "notify"; level: "info" | "warning" | "error"; message: string }
	// Observable clear at a runtime-generation boundary (reload/replacement), so
	// cross-process mirrors drop the previous generation's snapshot too.
	| { type: "reset" };

export type ExtensionOverlayAnchor =
	| "center"
	| "top-left"
	| "top-right"
	| "bottom-left"
	| "bottom-right"
	| "top-center"
	| "bottom-center"
	| "left-center"
	| "right-center";

export type ExtensionOverlaySizeValue = number | `${number}%`;

export interface ExtensionOverlayMargin {
	top: number;
	right: number;
	bottom: number;
	left: number;
}

export interface ExtensionCustomPanelLayout {
	width: ExtensionOverlaySizeValue | null;
	minWidth: number | null;
	maxHeight: ExtensionOverlaySizeValue | null;
	anchor: ExtensionOverlayAnchor;
	row: ExtensionOverlaySizeValue | null;
	col: ExtensionOverlaySizeValue | null;
	offsetX: number;
	offsetY: number;
	margin: ExtensionOverlayMargin | null;
	nonCapturing: boolean;
}

export interface ExtensionUiStateSnapshot {
	statuses: { key: string; text: string }[];
	widgets: { key: string; lines: string[]; placement: "aboveComposer" | "belowComposer" }[];
	headerLines: string[] | null;
	footerLines: string[] | null;
	workingMessage: string | null;
	workingVisible: boolean;
	workingIndicator: ExtensionWorkingIndicatorSnapshot | null;
	customPanel: { lines: string[]; hidden: boolean; focused: boolean; layout: ExtensionCustomPanelLayout } | null;
	notifications: { id: string; level: "info" | "warning" | "error"; message: string; createdAt: number }[];
	title: string | null;
	editorText: string | null;
	voiceSettingsRequestId: string | null;
	mcpSettingsRequestId: string | null;
	mcpStatus: McpStatus | null;
	terminalInputListening: boolean;
	toolsExpanded: boolean;
	hiddenThinkingLabel: string | null;
}

/**
 * Empty extension-UI snapshot: the default before a session has any extension writes, and a stable
 * reference so renderer consumers don't each build a fresh literal and re-render on identity alone.
 */
export const EMPTY_EXTENSION_UI_STATE: ExtensionUiStateSnapshot = {
	statuses: [],
	widgets: [],
	headerLines: null,
	footerLines: null,
	workingMessage: null,
	workingVisible: true,
	workingIndicator: null,
	customPanel: null,
	notifications: [],
	title: null,
	editorText: null,
	voiceSettingsRequestId: null,
	mcpSettingsRequestId: null,
	mcpStatus: null,
	terminalInputListening: false,
	toolsExpanded: false,
	hiddenThinkingLabel: null,
};

export type ExtensionUiInputRequest = z.infer<RequestSchemasShape["extensionUiInputRequestSchema"]>;

export interface ExtensionTerminalInputResult {
	consumed: boolean;
	data: string;
}

export type ExtensionTerminalInputReplayModifier =
	"shift" | "control" | "alt" | "isautorepeat" | "iskeypad" | "capslock" | "numlock";

/** A native keyboard phase or exact text insertion replayed after an asynchronous extension listener declines it. */
export type ExtensionTerminalInputReplayRequest =
	| {
			type: "keyDown" | "char" | "keyUp";
			keyCode: string;
			modifiers: ExtensionTerminalInputReplayModifier[];
	  }
	| { type: "insertText"; text: string };

export type ExtensionUiViewportRequest = z.infer<RequestSchemasShape["extensionUiViewportRequestSchema"]>;

export type ExtensionUiEditorTextRequest = z.infer<RequestSchemasShape["extensionUiEditorTextRequestSchema"]>;

/** 64K cap on single-line inputs like ctx.ui.input; bounds extension prompt input so unbounded user/extension text can't cross IPC. */
export const EXTENSION_UI_INPUT_MAX_CHARS = 65_536;
/** 1M cap on extension-UI multi-line/status text; same tier as the message body, covering widget/header/footer projections. */
export const EXTENSION_UI_TEXT_MAX_CHARS = 1_048_576;
/** Cap on extension status/widget collections; limits the fixed overhead that even empty-string objects incur. */
export const EXTENSION_UI_STATE_COLLECTION_MAX_ITEMS = 64;
/** Max length of an extension status/widget key; shared across all Pi UI owners and the final snapshot boundary. */
export const EXTENSION_UI_KEY_MAX_CHARS = 1_024;
/** Cap on lines rendered at once; shared by component rendering and the final snapshot boundary. */
export const EXTENSION_UI_RENDERED_LINE_MAX_ITEMS = 4_096;
/** Cap on custom working-indicator animation frames; shared by normalization and the final snapshot boundary. */
export const EXTENSION_UI_WORKING_FRAME_MAX_ITEMS = 256;
/** Cap on autocomplete source lines; limits how many lines a completion provider scans/returns. */
export const EXTENSION_AUTOCOMPLETE_MAX_LINES = 16_384;
/** Cap on autocomplete items; shared by the UI list and IPC list so a single completion can't explode. */
export const EXTENSION_AUTOCOMPLETE_MAX_ITEMS = 256;
/** Max characters of a single completion label; keeps sidebar/popover labels bounded. */
export const EXTENSION_AUTOCOMPLETE_LABEL_MAX_CHARS = 4_096;
/** Max characters of a single completion description; allows longer notes while still bounding the field. */
export const EXTENSION_AUTOCOMPLETE_DESCRIPTION_MAX_CHARS = 16_384;
/** 1M cap on total completion-response characters; a multi-field aggregate cap so batched suggestions can't blow up structured-clone. */
export const EXTENSION_AUTOCOMPLETE_TOTAL_MAX_CHARS = 1_048_576;

export interface ExtensionAutocompleteItem {
	value: string;
	label: string;
	description?: string;
}

export type SessionRuntimeBindingRequest = z.infer<RequestSchemasShape["sessionRuntimeBindingRequestSchema"]>;

export type ExtensionAutocompleteRequest = z.infer<RequestSchemasShape["extensionAutocompleteRequestSchema"]>;

export interface ExtensionAutocompleteSuggestions {
	items: ExtensionAutocompleteItem[];
	prefix: string;
}

export type SessionCommandArgumentCompletionRequest = z.infer<
	RequestSchemasShape["sessionCommandArgumentCompletionRequestSchema"]
>;

export type ApplyExtensionAutocompleteRequest = z.infer<RequestSchemasShape["applyExtensionAutocompleteRequestSchema"]>;

export interface ApplyExtensionAutocompleteResult {
	text: string;
	cursorOffset: number;
}
