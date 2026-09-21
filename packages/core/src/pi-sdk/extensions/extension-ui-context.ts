import { Theme } from "@earendil-works/pi-coding-agent";
import {
	EXTENSION_UI_TEXT_MAX_CHARS,
	EXTENSION_UI_WORKING_FRAME_MAX_ITEMS,
	type ExtensionWorkingIndicatorSnapshot,
} from "@ling/contracts/session-extension-ui";
import { sessionKey, type SessionRef } from "@ling/contracts/session-ref";
import { attemptCleanup, createLingError, throwAggregateFailures } from "@ling/core/ling-error";
import { unsupportedExtensionUi as unsupported, type ExtensionUiBridge } from "../../pi-protocol/extension-ui";
import type { PiExtensionUiContext, PiTheme } from "../types";
import { createPiExtensionAutocomplete } from "./extension-ui-autocomplete";
import { createExtensionUiCapabilities, staleExtensionUiContext } from "./extension-ui-capability";
import {
	createPiExtensionComponents,
	getPiSdkThemes,
	type PiExtensionUiContextOptions,
	type PiFooterFactory,
	type PiHeaderFactory,
} from "./extension-ui-components";
import { createPiExtensionCustomPanels, type PiCustomFactory } from "./extension-ui-custom-panel";
import { createPiExtensionFooterData } from "./extension-ui-footer-data";
import { createExtensionUiInteractions } from "./extension-ui-interactions";
import type { PiCustomOptions } from "./extension-ui-overlay-layout";
import { createPiExtensionTerminalInput } from "./extension-ui-terminal-input";
import { createExtensionUiViewports } from "./extension-ui-viewport";

function normalizeWorkingIndicator(
	options: Parameters<PiExtensionUiContext["setWorkingIndicator"]>[0],
): ExtensionWorkingIndicatorSnapshot | null {
	if (options === undefined) return null;
	const indicator: ExtensionWorkingIndicatorSnapshot = {};
	if (options.frames !== undefined) {
		if (!Array.isArray(options.frames) || options.frames.length > EXTENSION_UI_WORKING_FRAME_MAX_ITEMS) {
			throw new TypeError("Working indicator frames must be strings");
		}
		let totalChars = 0;
		for (const frame of options.frames) {
			if (typeof frame !== "string") throw new TypeError("Working indicator frames must be strings");
			totalChars += frame.length;
			if (totalChars > EXTENSION_UI_TEXT_MAX_CHARS) {
				throw new TypeError("Working indicator frames are too large");
			}
		}
		indicator.frames = [...options.frames];
	}
	if (options.intervalMs !== undefined) {
		if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs <= 0) {
			throw new TypeError("Working indicator interval must be a positive integer");
		}
		indicator.intervalMs = options.intervalMs;
	}
	return indicator;
}

function assertThemeName(theme: PiTheme, capability: string): asserts theme is PiTheme & { name: string } {
	if (typeof theme.name !== "string" || theme.name.trim().length === 0) unsupported(`${capability}.theme.name`);
}

type PiExtensionUiContextWithRender = PiExtensionUiContext & { requestRender(): void };

export function createPiExtensionUi(bridge: ExtensionUiBridge) {
	const capabilities = createExtensionUiCapabilities();
	const viewports = createExtensionUiViewports();
	const autocomplete = createPiExtensionAutocomplete();
	const footerData = createPiExtensionFooterData();
	const terminalInput = createPiExtensionTerminalInput(bridge);
	const components = createPiExtensionComponents({ bridge, capabilities, footerData, viewports });
	const customPanels = createPiExtensionCustomPanels({ bridge, components, terminalInput, viewports });
	const contexts = new Map<
		string,
		{ ref: SessionRef; interactions: ReturnType<typeof createExtensionUiInteractions> }
	>();
	let disposed = false;
	let disposal: Promise<void> | null = null;
	const {
		emitExtensionUiState,
		getApprovalRequester,
		getExtensionUiEditorText,
		getExtensionUiRequester,
		getExtensionUiState,
	} = bridge;
	const { disposePiExtensionAutocomplete, registerPiExtensionAutocompleteProvider } = autocomplete;
	const {
		assertActiveExtensionUiCapability,
		createExtensionUiCapability,
		disposeExtensionUiCapability,
		guardExtensionUiContext,
	} = capabilities;
	const {
		createPiExtensionThemeProxy,
		disposePiExtensionComponents,
		rerenderPiExtensionComponents,
		rerenderPiExtensionFooter,
		setPiExtensionFooter,
		setPiExtensionHeader,
		setPiExtensionTheme,
		setPiExtensionWidget,
	} = components;
	const { disposePiExtensionCustomPanel, rerenderPiExtensionCustomPanel, showPiExtensionCustomPanel } = customPanels;
	const { disposePiExtensionFooterData, setPiExtensionStatus } = footerData;
	const { addPiExtensionTerminalInputHandler, disposePiExtensionTerminalInputHandlers } = terminalInput;

	function disposePiExtensionUiContext(ref: SessionRef): void {
		const key = sessionKey(ref);
		const failures: unknown[] = [];
		attemptCleanup(failures, () => preparePiExtensionUiShutdown(ref));
		contexts.delete(key);
		disposeExtensionUiCapability(key);
		disposePiExtensionComponents(ref, failures);
		const cleanups = [
			() => disposePiExtensionCustomPanel(ref),
			() => disposePiExtensionAutocomplete(ref),
			() => disposePiExtensionTerminalInputHandlers(ref),
			() => disposePiExtensionFooterData(ref),
		];
		for (const cleanup of cleanups) attemptCleanup(failures, cleanup);
		throwAggregateFailures(failures, "Failed to dispose the Pi extension UI context");
	}

	/** Release waits before draining their commands; shutdown hooks may still update non-interactive UI. */
	function preparePiExtensionUiShutdown(ref: SessionRef): void {
		const context = contexts.get(sessionKey(ref));
		if (!context) return;
		context.interactions.close(
			createLingError({
				code: "REQUEST_CANCELLED",
				category: "lifecycle",
				message: "The session is closing",
				retryable: false,
			}),
		);
		disposePiExtensionCustomPanel(ref);
	}

	function cancelPiExtensionUiInteractions<T>(ref: SessionRef, operation: () => Promise<T>): Promise<T> {
		const context = contexts.get(sessionKey(ref));
		// A runtime with no bound UI context has no Ling interactions to release.
		if (!context) return operation();
		return context.interactions.cancelWhile(() => disposePiExtensionCustomPanel(ref), operation);
	}

	function createPiExtensionUiContext(
		ref: SessionRef,
		options: PiExtensionUiContextOptions = {},
	): PiExtensionUiContext {
		if (disposed) throw staleExtensionUiContext();
		const interactions = createExtensionUiInteractions();
		contexts.set(sessionKey(ref), { ref, interactions });
		const interactionOptions = (options?: { timeout?: number; signal?: AbortSignal }) => {
			const signal = interactions.signal;
			return {
				...options,
				signal: options?.signal ? AbortSignal.any([signal, options.signal]) : signal,
			};
		};
		const capability = createExtensionUiCapability(sessionKey(ref));
		const themeProxy = createPiExtensionThemeProxy(ref, capability);
		const context: PiExtensionUiContextWithRender = {
			async select(title, options, opts) {
				const requester = getExtensionUiRequester(ref);
				if (!requester) unsupported("select");
				return requester(ref, { kind: "select", title, options, promptOptions: interactionOptions(opts) });
			},
			async confirm(title, message, opts) {
				const requester = getApprovalRequester(ref);
				if (!requester) unsupported("confirm");
				return requester({ ref, title, message, options: interactionOptions(opts) });
			},
			async input(title, placeholder, opts) {
				const requester = getExtensionUiRequester(ref);
				if (!requester) unsupported("input");
				return requester(ref, {
					kind: "input",
					title,
					placeholder: placeholder === undefined ? null : placeholder,
					promptOptions: interactionOptions(opts),
				});
			},
			notify(message, type) {
				emitExtensionUiState(ref, { type: "notify", level: type === undefined ? "info" : type, message });
			},
			onTerminalInput(handler) {
				return addPiExtensionTerminalInputHandler(ref, handler);
			},
			setStatus(key, text) {
				setPiExtensionStatus(ref, key, text);
				emitExtensionUiState(ref, { type: "status", key, text: text === undefined ? null : text });
				rerenderPiExtensionFooter(ref);
			},
			setWorkingMessage(message) {
				emitExtensionUiState(ref, {
					type: "workingMessage",
					message: message === undefined ? null : message,
				});
			},
			setWorkingVisible(visible) {
				emitExtensionUiState(ref, { type: "workingVisible", visible });
			},
			setWorkingIndicator(indicator) {
				emitExtensionUiState(ref, { type: "workingIndicator", indicator: normalizeWorkingIndicator(indicator) });
			},
			setHiddenThinkingLabel(label) {
				emitExtensionUiState(ref, { type: "hiddenThinkingLabel", label: label === undefined ? null : label });
			},
			setWidget(key, content, widgetOptions) {
				setPiExtensionWidget(ref, key, content, widgetOptions?.placement);
			},
			setFooter(factory) {
				setPiExtensionFooter(ref, factory as PiFooterFactory | undefined, options, capability);
			},
			setHeader(factory) {
				setPiExtensionHeader(ref, factory as PiHeaderFactory | undefined);
			},
			setTitle(title) {
				emitExtensionUiState(ref, { type: "title", title });
			},
			custom: ((factory: unknown, customOptions?: PiCustomOptions) => {
				interactions.signal.throwIfAborted();
				return showPiExtensionCustomPanel(ref, factory as PiCustomFactory<unknown>, customOptions);
			}) as PiExtensionUiContext["custom"],
			pasteToEditor(text) {
				const current = getExtensionUiEditorText(ref);
				emitExtensionUiState(ref, { type: "editorText", text: current ? `${current}${text}` : text });
			},
			setEditorText(text) {
				emitExtensionUiState(ref, { type: "editorText", text });
			},
			getEditorText() {
				return getExtensionUiEditorText(ref);
			},
			async editor(title, prefill) {
				const requester = getExtensionUiRequester(ref);
				if (!requester) unsupported("editor");
				return requester(ref, {
					kind: "editor",
					title,
					initialValue: prefill === undefined ? "" : prefill,
					promptOptions: interactionOptions(),
				});
			},
			addAutocompleteProvider(factory) {
				registerPiExtensionAutocompleteProvider(ref, factory);
			},
			setEditorComponent() {
				unsupported("setEditorComponent");
			},
			getEditorComponent() {
				unsupported("getEditorComponent");
			},
			get theme(): PiTheme {
				return themeProxy;
			},
			getAllThemes() {
				return getPiSdkThemes(options).map((theme) => {
					assertThemeName(theme, "getAllThemes");
					return { name: theme.name, path: theme.sourcePath };
				});
			},
			getTheme(name) {
				return getPiSdkThemes(options).find((candidate) => candidate.name === name);
			},
			setTheme(nextTheme) {
				if (nextTheme === themeProxy) return { success: true };
				if (nextTheme instanceof Theme) {
					setPiExtensionTheme(ref, nextTheme);
					rerenderPiExtensionCustomPanel(ref);
					return { success: true };
				}
				const theme = context.getTheme(nextTheme);
				if (!theme) return { success: false, error: `Theme not found: ${nextTheme}` };
				setPiExtensionTheme(ref, theme);
				rerenderPiExtensionCustomPanel(ref);
				return { success: true };
			},
			getToolsExpanded() {
				return getExtensionUiState(ref).toolsExpanded;
			},
			setToolsExpanded(expanded) {
				emitExtensionUiState(ref, { type: "toolsExpanded", expanded });
			},
			requestRender() {
				rerenderPiExtensionComponents(ref);
				rerenderPiExtensionCustomPanel(ref);
			},
		};
		const guarded = guardExtensionUiContext(context, capability);
		assertActiveExtensionUiCapability(capability);
		return guarded;
	}

	function dispose(): Promise<void> {
		if (disposal) return disposal;
		disposed = true;
		const failures: unknown[] = [];
		for (const { ref } of [...contexts.values()]) attemptCleanup(failures, () => disposePiExtensionUiContext(ref));
		capabilities.dispose();
		viewports.dispose();
		autocomplete.dispose();
		disposal = footerData.dispose().then(
			() => {
				throwAggregateFailures(failures, "Failed to dispose Pi extension UI");
			},
			(error) => {
				throw new AggregateError([...failures, error], "Failed to dispose Pi extension UI");
			},
		);
		return disposal;
	}
	return {
		createPiExtensionUiContext,
		preparePiExtensionUiShutdown,
		cancelPiExtensionUiInteractions,
		disposePiExtensionUiContext,
		bridge,
		capabilities,
		viewports,
		autocomplete,
		components,
		customPanels,
		terminalInput,
		dispose,
	};
}

export type PiExtensionUi = ReturnType<typeof createPiExtensionUi>;
