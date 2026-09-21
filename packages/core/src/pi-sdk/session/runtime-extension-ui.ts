import type {
	ApplyExtensionAutocompleteResult,
	ExtensionAutocompleteItem,
	ExtensionAutocompleteSuggestions,
	ExtensionTerminalInputResult,
	SessionRef,
} from "@ling/contracts/session";
import type { SessionRuntimeTranscriptProjectionReason } from "@ling/core/pi-protocol/runtime-types";
import type { PiExtensionUi } from "../extensions/extension-ui-context";
import { hasPiMarkdownTransformers } from "../extensions/markdown-transformer";
import type { PiAgentSessionRuntime } from "../types";
import type { PiRuntimeOperationCoordinator } from "./runtime-operations";
interface RuntimeExtensionUiOwner {
	runtime(): PiAgentSessionRuntime;
	ref(): SessionRef;
	extensionUi: PiExtensionUi;
	operations: PiRuntimeOperationCoordinator;
	isDisposed(): boolean;
	assertAvailable(): void;
	canUpdateMirror(): boolean;
	emitTranscriptProjectionChanged(reason: SessionRuntimeTranscriptProjectionReason): void;
}
interface PiRuntimeExtensionUi {
	sendExtensionUiInput(data: string): Promise<ExtensionTerminalInputResult>;
	dispatchExtensionTerminalInput(data: string): Promise<ExtensionTerminalInputResult>;
	updateExtensionUiViewport(columns: number, rows: number, markdownColumns: number, dockColumns: number): Promise<void>;
	setExtensionUiEditorText(text: string): Promise<void>;
	getExtensionAutocompleteSuggestions(
		text: string,
		cursorOffset: number,
		force: boolean,
		signal?: AbortSignal,
	): Promise<ExtensionAutocompleteSuggestions | null>;
	applyExtensionAutocomplete(
		text: string,
		cursorOffset: number,
		item: ExtensionAutocompleteItem,
		prefix: string,
	): Promise<ApplyExtensionAutocompleteResult>;
	releaseExtensionUi(ref: SessionRef): void;
}
export function createPiRuntimeExtensionUi(owner: RuntimeExtensionUiOwner): PiRuntimeExtensionUi {
	return {
		sendExtensionUiInput(data: string) {
			return sendExtensionUiInput(owner, data);
		},
		dispatchExtensionTerminalInput(data: string) {
			return dispatchExtensionTerminalInput(owner, data);
		},
		updateExtensionUiViewport(columns: number, rows: number, markdownColumns: number, dockColumns: number) {
			return updateExtensionUiViewport(owner, columns, rows, markdownColumns, dockColumns);
		},
		setExtensionUiEditorText(text: string) {
			return setExtensionUiEditorText(owner, text);
		},
		getExtensionAutocompleteSuggestions(text: string, cursorOffset: number, force: boolean, signal?: AbortSignal) {
			return getExtensionAutocompleteSuggestions(owner, text, cursorOffset, force, signal);
		},
		applyExtensionAutocomplete(text: string, cursorOffset: number, item: ExtensionAutocompleteItem, prefix: string) {
			return applyExtensionAutocomplete(owner, text, cursorOffset, item, prefix);
		},
		releaseExtensionUi(ref: SessionRef) {
			return releaseExtensionUi(owner, ref);
		},
	};
}

async function sendExtensionUiInput(
	owner: RuntimeExtensionUiOwner,
	data: string,
): Promise<ExtensionTerminalInputResult> {
	if (owner.isDisposed()) {
		return { consumed: false, data };
	}
	owner.assertAvailable();
	return owner.extensionUi.customPanels.sendPiExtensionUiInput(owner.ref(), data);
}

async function dispatchExtensionTerminalInput(
	owner: RuntimeExtensionUiOwner,
	data: string,
): Promise<ExtensionTerminalInputResult> {
	if (owner.isDisposed()) {
		return { consumed: false, data };
	}
	owner.assertAvailable();
	return owner.extensionUi.terminalInput.dispatchPiExtensionTerminalInput(owner.ref(), data);
}

async function updateExtensionUiViewport(
	owner: RuntimeExtensionUiOwner,
	columns: number,
	rows: number,
	markdownColumns: number,
	dockColumns: number,
): Promise<void> {
	// Passive renderer mirrors may outlive an invalidated generation. Applying them
	// only after the replacement has bound prevents old state from leaking forward.
	if (!owner.canUpdateMirror()) return;
	const changed = owner.extensionUi.customPanels.updatePiExtensionUiViewport(owner.ref(), {
		columns,
		rows,
		markdownColumns,
		dockColumns,
	});
	// Components draw to a fixed column count, so a resized surface needs a fresh render;
	// the header follows the transcript width, widgets and the footer follow the dock.
	if (changed.dockColumns || changed.markdownColumns)
		owner.extensionUi.components.rerenderPiExtensionComponents(owner.ref());
	if (changed.markdownColumns && hasPiMarkdownTransformers(owner.runtime().session)) {
		owner.emitTranscriptProjectionChanged("markdownWidth");
	}
}

async function setExtensionUiEditorText(owner: RuntimeExtensionUiOwner, text: string): Promise<void> {
	if (!owner.canUpdateMirror()) return;
	owner.extensionUi.bridge.setExtensionUiEditorTextMirror(owner.ref(), text);
}

async function getExtensionAutocompleteSuggestions(
	owner: RuntimeExtensionUiOwner,
	text: string,
	cursorOffset: number,
	force: boolean,
	signal?: AbortSignal,
): Promise<ExtensionAutocompleteSuggestions | null> {
	return owner.operations.run(() =>
		owner.extensionUi.autocomplete.getPiExtensionAutocompleteSuggestions(
			owner.ref(),
			text,
			cursorOffset,
			force,
			signal,
		),
	);
}

async function applyExtensionAutocomplete(
	owner: RuntimeExtensionUiOwner,
	text: string,
	cursorOffset: number,
	item: ExtensionAutocompleteItem,
	prefix: string,
): Promise<ApplyExtensionAutocompleteResult> {
	owner.assertAvailable();
	return owner.extensionUi.autocomplete.applyPiExtensionAutocomplete(owner.ref(), text, cursorOffset, item, prefix);
}

function releaseExtensionUi(owner: RuntimeExtensionUiOwner, ref: SessionRef): void {
	try {
		owner.extensionUi.disposePiExtensionUiContext(ref);
	} finally {
		owner.extensionUi.customPanels.disposePiExtensionUiViewport(ref);
	}
}
