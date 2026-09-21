import {
	EXTENSION_AUTOCOMPLETE_DESCRIPTION_MAX_CHARS,
	EXTENSION_AUTOCOMPLETE_LABEL_MAX_CHARS,
	EXTENSION_AUTOCOMPLETE_MAX_ITEMS,
	EXTENSION_AUTOCOMPLETE_MAX_LINES,
	EXTENSION_AUTOCOMPLETE_TOTAL_MAX_CHARS,
	EXTENSION_UI_INPUT_MAX_CHARS,
	EXTENSION_UI_TEXT_MAX_CHARS,
} from "@ling/contracts/session";
import type {
	ApplyExtensionAutocompleteResult,
	ExtensionAutocompleteItem,
	ExtensionAutocompleteSuggestions,
} from "@ling/contracts/session-extension-ui";
import type { SessionRef } from "@ling/contracts/session-ref";
import { sessionKey } from "@ling/contracts/session-ref";
import { throwIfOperationAborted, waitForOperation } from "../../ling-error";
import { unsupportedExtensionUi as unsupported } from "../../pi-protocol/extension-ui";

type PiAutocompleteProviderFactory = (current: PiAutocompleteProvider) => PiAutocompleteProvider;

type PiAutocompleteProvider = {
	triggerCharacters?: string[];
	getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		options: { signal: AbortSignal; force?: boolean },
	): Promise<ExtensionAutocompleteSuggestions | null>;
	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: ExtensionAutocompleteItem,
		prefix: string,
	): { lines: string[]; cursorLine: number; cursorCol: number };
	shouldTriggerFileCompletion?(lines: string[], cursorLine: number, cursorCol: number): boolean;
};

interface PiAutocompleteProviderRegistration {
	provider: PiAutocompleteProvider;
}

function splitTextAtCursor(
	text: string,
	cursorOffset: number,
): { lines: string[]; cursorLine: number; cursorCol: number } {
	if (!Number.isInteger(cursorOffset) || cursorOffset < 0 || cursorOffset > text.length) {
		unsupported("autocomplete.cursorOffset");
	}
	let lineCount = 1;
	for (let index = 0; index < text.length; index += 1) {
		if (text.charCodeAt(index) !== 10) continue;
		lineCount += 1;
		if (lineCount > EXTENSION_AUTOCOMPLETE_MAX_LINES) unsupported("autocomplete.lines");
	}
	const before = text.slice(0, cursorOffset);
	const lines = text.split("\n");
	const beforeLines = before.split("\n");
	const cursorLine = beforeLines.length - 1;
	const cursorCol = beforeLines[cursorLine]?.length ?? 0;
	return { lines, cursorLine, cursorCol };
}

function cursorOffsetFromLines(lines: readonly string[], cursorLine: number, cursorCol: number): number {
	if (
		!Number.isInteger(cursorLine) ||
		!Number.isInteger(cursorCol) ||
		cursorLine < 0 ||
		cursorLine >= lines.length ||
		cursorCol < 0 ||
		cursorCol > (lines[cursorLine]?.length ?? -1)
	) {
		unsupported("autocomplete.applyCompletion");
	}
	let offset = 0;
	for (let index = 0; index < cursorLine; index += 1) offset += (lines[index]?.length ?? 0) + 1;
	return offset + cursorCol;
}

function assertPrefixBeforeCursor(
	lines: readonly string[],
	cursorLine: number,
	cursorCol: number,
	prefix: string,
): void {
	const line = lines[cursorLine] ?? "";
	const prefixStart = cursorCol - prefix.length;
	if (prefixStart < 0 || line.slice(prefixStart, cursorCol) !== prefix) {
		unsupported("autocomplete.applyCompletion.prefix");
	}
}

function assertPiExtensionAutocompleteItem(value: unknown): asserts value is ExtensionAutocompleteItem {
	if (typeof value !== "object" || value === null) unsupported("autocomplete.item");
	const item = value as Partial<ExtensionAutocompleteItem>;
	if (typeof item.value !== "string" || typeof item.label !== "string") unsupported("autocomplete.item");
	if (item.value.length > EXTENSION_UI_INPUT_MAX_CHARS) unsupported("autocomplete.item.value");
	if (item.label.length > EXTENSION_AUTOCOMPLETE_LABEL_MAX_CHARS) unsupported("autocomplete.item.label");
	if (item.description !== undefined && typeof item.description !== "string")
		unsupported("autocomplete.item.description");
	if (item.description !== undefined && item.description.length > EXTENSION_AUTOCOMPLETE_DESCRIPTION_MAX_CHARS) {
		unsupported("autocomplete.item.description");
	}
}

export function assertPiExtensionAutocompleteSuggestions(
	value: unknown,
): asserts value is ExtensionAutocompleteSuggestions {
	if (typeof value !== "object" || value === null) unsupported("autocomplete.suggestions");
	const suggestions = value as Partial<ExtensionAutocompleteSuggestions>;
	if (typeof suggestions.prefix !== "string" || !Array.isArray(suggestions.items)) {
		unsupported("autocomplete.suggestions");
	}
	if (suggestions.prefix.length > EXTENSION_UI_INPUT_MAX_CHARS) unsupported("autocomplete.suggestions.prefix");
	if (suggestions.items.length > EXTENSION_AUTOCOMPLETE_MAX_ITEMS) unsupported("autocomplete.suggestions.items");
	let totalChars = suggestions.prefix.length;
	for (const item of suggestions.items) {
		assertPiExtensionAutocompleteItem(item);
		totalChars += item.value.length + item.label.length + (item.description?.length ?? 0);
		if (totalChars > EXTENSION_AUTOCOMPLETE_TOTAL_MAX_CHARS) unsupported("autocomplete.suggestions.size");
	}
}

function assertAutocompleteResultLines(value: unknown): asserts value is string[] {
	if (!Array.isArray(value) || value.length > EXTENSION_AUTOCOMPLETE_MAX_LINES) {
		unsupported("autocomplete.applyCompletion.lines");
	}
	let totalChars = Math.max(0, value.length - 1);
	for (const line of value) {
		if (typeof line !== "string") unsupported("autocomplete.applyCompletion.lines");
		totalChars += line.length;
		if (totalChars > EXTENSION_UI_TEXT_MAX_CHARS) unsupported("autocomplete.applyCompletion.lines");
	}
}

function createBaseAutocompleteProvider(): PiAutocompleteProvider {
	return {
		async getSuggestions() {
			return null;
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			assertPrefixBeforeCursor(lines, cursorLine, cursorCol, prefix);
			const currentLine = lines[cursorLine] ?? "";
			const before = currentLine.slice(0, cursorCol - prefix.length);
			const after = currentLine.slice(cursorCol);
			const nextLine = `${before}${item.value}${after}`;
			return {
				lines: [...lines.slice(0, cursorLine), nextLine, ...lines.slice(cursorLine + 1)],
				cursorLine,
				cursorCol: before.length + item.value.length,
			};
		},
	};
}

export function createPiExtensionAutocomplete() {
	const autocompleteProviderBySession = new Map<string, PiAutocompleteProviderRegistration>();

	function autocompleteRegistration(ref: SessionRef): PiAutocompleteProviderRegistration | undefined {
		return autocompleteProviderBySession.get(sessionKey(ref));
	}

	function registerPiExtensionAutocompleteProvider(ref: SessionRef, factory: PiAutocompleteProviderFactory): void {
		const current = autocompleteRegistration(ref)?.provider ?? createBaseAutocompleteProvider();
		const next = factory(current);
		if (
			typeof next !== "object" ||
			next === null ||
			typeof next.getSuggestions !== "function" ||
			typeof next.applyCompletion !== "function"
		) {
			unsupported("addAutocompleteProvider");
		}
		autocompleteProviderBySession.set(sessionKey(ref), { provider: next });
	}

	function disposePiExtensionAutocomplete(ref: SessionRef): void {
		autocompleteProviderBySession.delete(sessionKey(ref));
	}

	async function getPiExtensionAutocompleteSuggestions(
		ref: SessionRef,
		text: string,
		cursorOffset: number,
		force: boolean,
		signal?: AbortSignal,
	): Promise<ExtensionAutocompleteSuggestions | null> {
		throwIfOperationAborted(signal);
		const registration = autocompleteRegistration(ref);
		if (!registration) return null;
		const { lines, cursorLine, cursorCol } = splitTextAtCursor(text, cursorOffset);
		const providerSignal = signal ?? new AbortController().signal;
		const result = await waitForOperation(
			registration.provider.getSuggestions(lines, cursorLine, cursorCol, { signal: providerSignal, force }),
			signal,
		);
		throwIfOperationAborted(signal);
		// A package/settings reload can replace the provider while its async lookup is
		// still running. Never publish suggestions owned by the retired generation.
		if (autocompleteRegistration(ref) !== registration) return null;
		if (result === null) return null;
		assertPiExtensionAutocompleteSuggestions(result);
		assertPrefixBeforeCursor(lines, cursorLine, cursorCol, result.prefix);
		return result;
	}

	function applyPiExtensionAutocomplete(
		ref: SessionRef,
		text: string,
		cursorOffset: number,
		item: ExtensionAutocompleteItem,
		prefix: string,
	): ApplyExtensionAutocompleteResult {
		const provider = autocompleteRegistration(ref)?.provider;
		if (!provider) throw new Error("No extension autocomplete provider registered");
		assertPiExtensionAutocompleteItem(item);
		if (prefix.length > EXTENSION_UI_INPUT_MAX_CHARS) unsupported("autocomplete.applyCompletion.prefix");
		const { lines, cursorLine, cursorCol } = splitTextAtCursor(text, cursorOffset);
		assertPrefixBeforeCursor(lines, cursorLine, cursorCol, prefix);
		const result = provider.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		if (typeof result !== "object" || result === null) unsupported("autocomplete.applyCompletion");
		assertAutocompleteResultLines(result.lines);
		const nextText = result.lines.join("\n");
		return {
			text: nextText,
			cursorOffset: cursorOffsetFromLines(result.lines, result.cursorLine, result.cursorCol),
		};
	}

	function dispose(): void {
		autocompleteProviderBySession.clear();
	}
	return {
		registerPiExtensionAutocompleteProvider,
		disposePiExtensionAutocomplete,
		getPiExtensionAutocompleteSuggestions,
		applyPiExtensionAutocomplete,
		dispose,
	};
}
