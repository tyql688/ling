import {
	EMPTY_EXTENSION_UI_STATE,
	EXTENSION_UI_KEY_MAX_CHARS,
	EXTENSION_UI_RENDERED_LINE_MAX_ITEMS,
	EXTENSION_UI_STATE_COLLECTION_MAX_ITEMS,
	EXTENSION_UI_TEXT_MAX_CHARS,
	EXTENSION_UI_WORKING_FRAME_MAX_ITEMS,
	type ExtensionUiStateEvent,
	type ExtensionUiStateSnapshot,
	type SessionRef,
} from "@ling/contracts/session";
import { sessionKey } from "@ling/contracts/session-ref";
import { requestCancelled } from "../ling-error";

interface ExtensionUiPromptOptions {
	signal?: AbortSignal;
	timeout?: number;
}

interface ApprovalRequest {
	ref: SessionRef;
	title: string;
	message: string;
	options?: ExtensionUiPromptOptions;
}

/** ctx.ui.confirm — boolean approve/deny dialog. */
export type ApprovalRequester = (request: ApprovalRequest) => Promise<boolean>;

/** ctx.ui.select / ctx.ui.input — choice and text-input dialogs. */
type ExtensionUiPrompt =
	| { kind: "select"; title: string; options: string[]; promptOptions?: ExtensionUiPromptOptions }
	| { kind: "input"; title: string; placeholder: string | null; promptOptions?: ExtensionUiPromptOptions }
	| { kind: "editor"; title: string; initialValue: string; promptOptions?: ExtensionUiPromptOptions };
export type ExtensionUiRequester = (ref: SessionRef, prompt: ExtensionUiPrompt) => Promise<string | undefined>;

type ExtensionUiStateListener = (
	ref: SessionRef,
	snapshot: ExtensionUiStateSnapshot,
	event: ExtensionUiStateEvent,
) => void;
type UnsupportedExtensionUiError = Error & {
	code: "UNSUPPORTED_EXTENSION_UI";
	capability: string;
};

export function createUnsupportedExtensionUiError(capability: string): UnsupportedExtensionUiError {
	return Object.assign(new Error(`Extension capability is not supported: ${capability}`), {
		code: "UNSUPPORTED_EXTENSION_UI" as const,
		capability,
	});
}

function assertExtensionText(value: string, capability: string, limit = EXTENSION_UI_TEXT_MAX_CHARS): void {
	if (value.length > limit) throw createUnsupportedExtensionUiError(capability);
}

function assertExtensionLines(lines: readonly string[], capability: string): void {
	if (lines.length > EXTENSION_UI_RENDERED_LINE_MAX_ITEMS) throw createUnsupportedExtensionUiError(capability);
	let totalChars = 0;
	for (const line of lines) {
		totalChars += line.length;
		if (totalChars > EXTENSION_UI_TEXT_MAX_CHARS) throw createUnsupportedExtensionUiError(capability);
	}
}

function assertExtensionUiStateEvent(state: ExtensionUiStateSnapshot, event: ExtensionUiStateEvent): void {
	switch (event.type) {
		case "status":
			assertExtensionText(event.key, "setStatus.key", EXTENSION_UI_KEY_MAX_CHARS);
			if (event.text !== null) {
				assertExtensionText(event.text, "setStatus.text");
				if (
					!state.statuses.some((status) => status.key === event.key) &&
					state.statuses.length >= EXTENSION_UI_STATE_COLLECTION_MAX_ITEMS
				) {
					throw createUnsupportedExtensionUiError("setStatus.count");
				}
			}
			return;
		case "widget":
			assertExtensionText(event.key, "setWidget.key", EXTENSION_UI_KEY_MAX_CHARS);
			if (event.placement !== null) {
				assertExtensionLines(event.lines, "setWidget.lines");
				if (
					!state.widgets.some((widget) => widget.key === event.key) &&
					state.widgets.length >= EXTENSION_UI_STATE_COLLECTION_MAX_ITEMS
				) {
					throw createUnsupportedExtensionUiError("setWidget.count");
				}
			}
			return;
		case "header":
			if (event.lines !== null) assertExtensionLines(event.lines, "setHeader.lines");
			return;
		case "footer":
			if (event.lines !== null) assertExtensionLines(event.lines, "setFooter.lines");
			return;
		case "custom":
			if (event.lines !== null) assertExtensionLines(event.lines, "custom.lines");
			return;
		case "workingMessage":
			if (event.message !== null) assertExtensionText(event.message, "setWorkingMessage.message");
			return;
		case "workingIndicator":
			if (event.indicator?.frames === undefined) return;
			if (event.indicator.frames.length > EXTENSION_UI_WORKING_FRAME_MAX_ITEMS) {
				throw createUnsupportedExtensionUiError("setWorkingIndicator.frames");
			}
			assertExtensionLines(event.indicator.frames, "setWorkingIndicator.frames");
			return;
		case "title":
			if (event.title !== null) assertExtensionText(event.title, "setTitle.title");
			return;
		case "editorText":
			assertExtensionText(event.text, "setEditorText.text");
			return;
		case "voiceSettings":
			assertExtensionText(event.requestId, "voiceSettings.requestId", EXTENSION_UI_KEY_MAX_CHARS);
			return;
		case "hiddenThinkingLabel":
			if (event.label !== null) assertExtensionText(event.label, "setHiddenThinkingLabel.label");
			return;
		case "notify":
			assertExtensionText(event.message, "notify.message");
			return;
		case "workingVisible":
		case "customVisibility":
		case "terminalInputListening":
		case "toolsExpanded":
		case "reset":
			return;
	}
}

function applyStateEvent(state: ExtensionUiStateSnapshot, event: ExtensionUiStateEvent): ExtensionUiStateSnapshot {
	switch (event.type) {
		case "voiceSettings":
			return { ...state, voiceSettingsRequestId: event.requestId };
		case "status":
			return {
				...state,
				statuses:
					event.text === null
						? state.statuses.filter((status) => status.key !== event.key)
						: [...state.statuses.filter((status) => status.key !== event.key), { key: event.key, text: event.text }],
			};
		case "widget":
			return {
				...state,
				widgets:
					event.placement === null
						? state.widgets.filter((widget) => widget.key !== event.key)
						: [
								...state.widgets.filter((widget) => widget.key !== event.key),
								{ key: event.key, lines: event.lines, placement: event.placement },
							],
			};
		case "header":
			return { ...state, headerLines: event.lines };
		case "footer":
			return { ...state, footerLines: event.lines };
		case "workingMessage":
			return { ...state, workingMessage: event.message };
		case "workingVisible":
			return { ...state, workingVisible: event.visible };
		case "workingIndicator":
			return { ...state, workingIndicator: event.indicator };
		case "custom":
			return {
				...state,
				customPanel:
					event.lines === null || event.layout === null
						? null
						: { lines: event.lines, hidden: event.hidden, focused: event.focused, layout: event.layout },
			};
		case "customVisibility":
			return state.customPanel === null
				? state
				: { ...state, customPanel: { ...state.customPanel, hidden: event.hidden, focused: event.focused } };
		case "title":
			return { ...state, title: event.title };
		case "editorText":
			return { ...state, editorText: event.text };
		case "terminalInputListening":
			return { ...state, terminalInputListening: event.listening };
		case "toolsExpanded":
			return { ...state, toolsExpanded: event.expanded };
		case "hiddenThinkingLabel":
			return { ...state, hiddenThinkingLabel: event.label };
		case "notify":
			return state;
		case "reset":
			return EMPTY_EXTENSION_UI_STATE;
	}
}

export interface ExtensionUiBridge {
	dispose(): void;
	registerApprovalRequester(ref: SessionRef, requester: ApprovalRequester): void;
	unregisterApprovalRequester(ref: SessionRef, requester?: ApprovalRequester): void;
	getApprovalRequester(ref: SessionRef): ApprovalRequester | undefined;
	registerExtensionUiRequester(ref: SessionRef, requester: ExtensionUiRequester): void;
	unregisterExtensionUiRequester(ref: SessionRef, requester?: ExtensionUiRequester): void;
	getExtensionUiRequester(ref: SessionRef): ExtensionUiRequester | undefined;
	emitExtensionUiState(ref: SessionRef, event: ExtensionUiStateEvent): ExtensionUiStateSnapshot;
	getExtensionUiState(ref: SessionRef): ExtensionUiStateSnapshot;
	setExtensionUiEditorTextMirror(ref: SessionRef, text: string): void;
	getExtensionUiEditorText(ref: SessionRef): string;
	clearExtensionUiState(ref: SessionRef): void;
	resetExtensionUiState(ref: SessionRef): void;
	onExtensionUiStateChanged(listener: ExtensionUiStateListener): () => void;
}

export function createExtensionUiBridge() {
	let disposed = false;
	function assertActive(): void {
		if (disposed) throw requestCancelled("The extension UI bridge has been disposed.");
	}
	const requesters = new Map<string, ApprovalRequester>();

	function registerApprovalRequester(ref: SessionRef, requester: ApprovalRequester): void {
		assertActive();
		requesters.set(sessionKey(ref), requester);
	}

	function unregisterApprovalRequester(ref: SessionRef, requester?: ApprovalRequester): void {
		const key = sessionKey(ref);
		if (requester && requesters.get(key) !== requester) return;
		requesters.delete(key);
	}

	function getApprovalRequester(ref: SessionRef): ApprovalRequester | undefined {
		assertActive();
		return requesters.get(sessionKey(ref));
	}

	const uiRequesters = new Map<string, ExtensionUiRequester>();

	function registerExtensionUiRequester(ref: SessionRef, requester: ExtensionUiRequester): void {
		assertActive();
		uiRequesters.set(sessionKey(ref), requester);
	}

	function unregisterExtensionUiRequester(ref: SessionRef, requester?: ExtensionUiRequester): void {
		const key = sessionKey(ref);
		if (requester && uiRequesters.get(key) !== requester) return;
		uiRequesters.delete(key);
	}

	function getExtensionUiRequester(ref: SessionRef): ExtensionUiRequester | undefined {
		assertActive();
		return uiRequesters.get(sessionKey(ref));
	}

	const stateBySession = new Map<string, ExtensionUiStateSnapshot>();
	const editorTextMirrorBySession = new Map<string, string>();
	const stateListeners = new Set<ExtensionUiStateListener>();
	let notificationSequence = 0;

	function currentState(ref: SessionRef): ExtensionUiStateSnapshot {
		assertActive();
		// A session has no UI state until an extension emits its first event.
		return stateBySession.get(sessionKey(ref)) ?? EMPTY_EXTENSION_UI_STATE;
	}

	function emitExtensionUiState(ref: SessionRef, event: ExtensionUiStateEvent): ExtensionUiStateSnapshot {
		const state = currentState(ref);
		assertExtensionUiStateEvent(state, event);
		if (event.type === "editorText") {
			editorTextMirrorBySession.set(sessionKey(ref), event.text);
		}
		const next =
			event.type === "notify"
				? {
						...state,
						notifications: [
							...state.notifications,
							{
								id: `notify:${Date.now()}:${notificationSequence++}`,
								level: event.level,
								message: event.message,
								createdAt: Date.now(),
							},
						].slice(-5),
					}
				: applyStateEvent(state, event);
		// A reset must free the map slot like clearExtensionUiState, not pin an empty snapshot.
		if (event.type === "reset") clearExtensionUiState(ref);
		else stateBySession.set(sessionKey(ref), next);
		for (const listener of stateListeners) listener(ref, next, event);
		return next;
	}

	function getExtensionUiState(ref: SessionRef): ExtensionUiStateSnapshot {
		return currentState(ref);
	}

	function setExtensionUiEditorTextMirror(ref: SessionRef, text: string): void {
		assertActive();
		editorTextMirrorBySession.set(sessionKey(ref), text);
	}

	function getExtensionUiEditorText(ref: SessionRef): string {
		assertActive();
		// A newly opened editor legitimately starts empty before the Web mirror arrives.
		return editorTextMirrorBySession.get(sessionKey(ref)) ?? currentState(ref).editorText ?? "";
	}

	function clearExtensionUiState(ref: SessionRef): void {
		stateBySession.delete(sessionKey(ref));
		editorTextMirrorBySession.delete(sessionKey(ref));
	}

	/** Clears like clearExtensionUiState, but as an observable "reset" event: the Pi worker
	 * forwards it to Main, whose mirror of this module would otherwise keep the previous
	 * generation's snapshot (e.g. stale notifications surviving an extension reload). */
	function resetExtensionUiState(ref: SessionRef): void {
		emitExtensionUiState(ref, { type: "reset" });
	}

	function onExtensionUiStateChanged(listener: ExtensionUiStateListener): () => void {
		assertActive();
		stateListeners.add(listener);
		return () => stateListeners.delete(listener);
	}

	function dispose(): void {
		disposed = true;
		requesters.clear();
		uiRequesters.clear();
		stateBySession.clear();
		editorTextMirrorBySession.clear();
		stateListeners.clear();
	}
	return {
		registerApprovalRequester,
		unregisterApprovalRequester,
		getApprovalRequester,
		registerExtensionUiRequester,
		unregisterExtensionUiRequester,
		getExtensionUiRequester,
		emitExtensionUiState,
		getExtensionUiState,
		setExtensionUiEditorTextMirror,
		getExtensionUiEditorText,
		clearExtensionUiState,
		resetExtensionUiState,
		onExtensionUiStateChanged,
		dispose,
	};
}

/** Unsupported Pi editor calls fail with the same typed capability error at every adapter surface. */
export function unsupportedExtensionUi(capability: string): never {
	throw createUnsupportedExtensionUiError(capability);
}
