import type {
	ExtensionTerminalInputReplayModifier,
	ExtensionTerminalInputReplayRequest,
} from "@ling/contracts/session-extension-ui";
import { isMac } from "@renderer/lib/platform";

const NATIVE_REPLAY_ARROW_KEY_CODES: Readonly<Record<string, string>> = {
	ArrowDown: "Down",
	ArrowLeft: "Left",
	ArrowRight: "Right",
	ArrowUp: "Up",
};
const NATIVE_REPLAY_CODE_KEY_CODES: Readonly<Record<string, string>> = {
	Backquote: "`",
	Backslash: "\\",
	BracketLeft: "[",
	BracketRight: "]",
	Comma: ",",
	Equal: "=",
	IntlBackslash: "\\",
	IntlRo: "\\",
	IntlYen: "\\",
	Minus: "-",
	NumpadAdd: "numadd",
	NumpadComma: "numdec",
	NumpadDecimal: "numdec",
	NumpadDivide: "numdiv",
	NumpadEnter: "Enter",
	NumpadEqual: "=",
	NumpadMultiply: "nummult",
	NumpadSubtract: "numsub",
	Period: ".",
	Quote: "'",
	Semicolon: ";",
	Slash: "/",
	Space: "Space",
};
const NATIVE_REPLAY_NAMED_KEY_CODES = new Set([
	"Backspace",
	"Delete",
	"End",
	"Enter",
	"Escape",
	"Home",
	"Insert",
	"PageDown",
	"PageUp",
	"Tab",
]);
const TEXT_INPUT_TYPES = new Set(["email", "password", "search", "tel", "text", "url"]);
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

interface ReplayIdentity {
	key: string;
	code: string;
	shiftKey: boolean;
	ctrlKey: boolean;
	altKey: boolean;
	metaKey: boolean;
	repeat: boolean;
	location: number;
	capsLock: boolean;
	numLock: boolean;
}

export interface ExtensionKeyReplay {
	identity: ReplayIdentity;
	keyDownKeyCode: string;
	modifiers: ExtensionTerminalInputReplayModifier[];
	textRequest: ExtensionTerminalInputReplayRequest | null;
}

function replayModifiers(event: KeyboardEvent): ExtensionTerminalInputReplayModifier[] {
	const modifiers: ExtensionTerminalInputReplayModifier[] = [];
	if (event.shiftKey) modifiers.push("shift");
	if (event.ctrlKey) modifiers.push("control");
	if (event.altKey) modifiers.push("alt");
	if (event.repeat) modifiers.push("isautorepeat");
	if (event.location === KeyboardEvent.DOM_KEY_LOCATION_NUMPAD) modifiers.push("iskeypad");
	if (event.getModifierState("CapsLock")) modifiers.push("capslock");
	if (event.getModifierState("NumLock")) modifiers.push("numlock");
	return modifiers;
}

function isNativeReplayCharacter(value: string): boolean {
	if (value.length !== 1) return false;
	const codePoint = value.charCodeAt(0);
	return codePoint >= 0x20 && codePoint <= 0x7e;
}

function replayTextRequest(
	event: KeyboardEvent,
	modifiers: ExtensionTerminalInputReplayModifier[],
): ExtensionTerminalInputReplayRequest | null {
	if (event.key === "Enter") return { type: "char", keyCode: event.key, modifiers };
	if (event.key.length !== 1 || event.ctrlKey || event.metaKey) return null;
	if (event.altKey && !isMac) return null;
	if (!isNativeReplayCharacter(event.key) || (isMac && event.altKey)) {
		return { type: "insertText", text: event.key };
	}
	return { type: "char", keyCode: event.key === " " ? "Space" : event.key, modifiers };
}

function nativeKeyDownCode(event: KeyboardEvent): string | null {
	if (/^Key[A-Z]$/u.test(event.code)) return event.code.slice(3);
	if (/^Digit[0-9]$/u.test(event.code)) return event.code.slice(5);
	if (/^Numpad[0-9]$/u.test(event.code)) return `num${event.code.slice(6)}`;
	const codeKey = NATIVE_REPLAY_CODE_KEY_CODES[event.code];
	if (codeKey !== undefined) return codeKey;
	const arrowKey = NATIVE_REPLAY_ARROW_KEY_CODES[event.key];
	if (arrowKey !== undefined) return arrowKey;
	if (/^F(?:[1-9]|1[0-9]|2[0-4])$/u.test(event.key)) return event.key;
	if (event.key === " ") return "Space";
	if (isNativeReplayCharacter(event.key)) return event.key;
	return NATIVE_REPLAY_NAMED_KEY_CODES.has(event.key) ? event.key : null;
}

export function captureExtensionKeyReplay(event: KeyboardEvent): ExtensionKeyReplay | null {
	const keyDownKeyCode = nativeKeyDownCode(event);
	if (keyDownKeyCode === null) return null;
	const modifiers = replayModifiers(event);
	return {
		identity: {
			key: event.key,
			code: event.code,
			shiftKey: event.shiftKey,
			ctrlKey: event.ctrlKey,
			altKey: event.altKey,
			metaKey: event.metaKey,
			repeat: event.repeat,
			location: event.location,
			capsLock: event.getModifierState("CapsLock"),
			numLock: event.getModifierState("NumLock"),
		},
		keyDownKeyCode,
		modifiers,
		textRequest: replayTextRequest(event, modifiers),
	};
}

export function matchesReplayKeyDown(event: KeyboardEvent, replay: ExtensionKeyReplay): boolean {
	const expected = replay.identity;
	return (
		(event.key === expected.key || (expected.code.length > 0 && event.code === expected.code)) &&
		event.shiftKey === expected.shiftKey &&
		event.ctrlKey === expected.ctrlKey &&
		event.altKey === expected.altKey &&
		event.metaKey === expected.metaKey &&
		(expected.repeat || !event.repeat) &&
		event.location === expected.location &&
		event.getModifierState("CapsLock") === expected.capsLock &&
		event.getModifierState("NumLock") === expected.numLock
	);
}

export function isEditableTextTarget(target: Element): target is HTMLInputElement | HTMLTextAreaElement {
	if (target instanceof HTMLTextAreaElement) return !target.disabled && !target.readOnly;
	return (
		target instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(target.type) && !target.disabled && !target.readOnly
	);
}

function selectionFocus(target: HTMLInputElement | HTMLTextAreaElement): number {
	const start = target.selectionStart ?? 0;
	const end = target.selectionEnd ?? start;
	return target.selectionDirection === "backward" ? start : end;
}

function moveSelection(target: HTMLInputElement | HTMLTextAreaElement, nextFocus: number, extend: boolean): void {
	const bounded = Math.max(0, Math.min(nextFocus, target.value.length));
	if (!extend) {
		target.setSelectionRange(bounded, bounded, "none");
		return;
	}
	const start = target.selectionStart ?? 0;
	const end = target.selectionEnd ?? start;
	const anchor = start === end ? start : target.selectionDirection === "backward" ? end : start;
	target.setSelectionRange(
		Math.min(anchor, bounded),
		Math.max(anchor, bounded),
		bounded < anchor ? "backward" : "forward",
	);
}

function graphemeBoundaries(value: string): number[] {
	const boundaries = [0];
	for (const segment of graphemeSegmenter.segment(value)) boundaries.push(segment.index + segment.segment.length);
	return boundaries;
}

function previousGraphemeOffset(value: string, offset: number): number {
	let previous = 0;
	for (const boundary of graphemeBoundaries(value)) {
		if (boundary >= offset) return previous;
		previous = boundary;
	}
	return previous;
}

function nextGraphemeOffset(value: string, offset: number): number {
	for (const boundary of graphemeBoundaries(value)) {
		if (boundary > offset) return boundary;
	}
	return value.length;
}

function lineStart(value: string, offset: number): number {
	return value.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
}

function lineEnd(value: string, offset: number): number {
	const newline = value.indexOf("\n", offset);
	return newline === -1 ? value.length : newline;
}

function verticalOffset(value: string, offset: number, direction: "previous" | "next"): number {
	const currentStart = lineStart(value, offset);
	const column = offset - currentStart;
	if (direction === "previous") {
		if (currentStart === 0) return offset;
		const previousEnd = currentStart - 1;
		const previousStart = lineStart(value, previousEnd);
		return Math.min(previousStart + column, previousEnd);
	}
	const currentEnd = lineEnd(value, offset);
	if (currentEnd === value.length) return offset;
	const nextStart = currentEnd + 1;
	return Math.min(nextStart + column, lineEnd(value, nextStart));
}

function replaceRange(
	target: HTMLInputElement | HTMLTextAreaElement,
	start: number,
	end: number,
	replacement: string,
	caret: number,
): void {
	if (start === end && replacement.length === 0) return;
	target.setSelectionRange(start, end);
	// eslint-disable-next-line @typescript-eslint/no-deprecated -- deprecated with no replacement: assigning `value` wipes the field's native undo stack, and insertText is the only edit the browser records as the user's own
	if (!document.execCommand("insertText", false, replacement)) {
		throw new Error("The desktop shell could not replay the declined extension input in the composer");
	}
	target.setSelectionRange(caret, caret, "none");
}

function transposeAtCaret(target: HTMLInputElement | HTMLTextAreaElement, focus: number): void {
	if (target.selectionStart !== target.selectionEnd || focus === 0) return;
	const value = target.value;
	let middle = focus;
	let start = previousGraphemeOffset(value, middle);
	let end = nextGraphemeOffset(value, middle);
	if (middle === value.length || value[middle] === "\n") {
		end = middle;
		middle = start;
		start = previousGraphemeOffset(value, middle);
	}
	if (start === middle || middle === end || value.slice(start, end).includes("\n")) return;
	const replacement = `${value.slice(middle, end)}${value.slice(start, middle)}`;
	replaceRange(target, start, end, replacement, end);
}

export function applyMacControlTextDefault(target: Element, replay: ExtensionKeyReplay): boolean {
	const identity = replay.identity;
	if (!isMac || !identity.ctrlKey || identity.altKey || identity.metaKey || !isEditableTextTarget(target)) return false;
	const key = identity.key.toLowerCase();
	const value = target.value;
	const focus = selectionFocus(target);
	const start = target.selectionStart ?? focus;
	const end = target.selectionEnd ?? focus;
	const extend = identity.shiftKey;

	switch (key) {
		case "a":
			moveSelection(target, lineStart(value, focus), extend);
			return true;
		case "b":
			moveSelection(target, !extend && start !== end ? start : previousGraphemeOffset(value, focus), extend);
			return true;
		case "d": {
			const deleteEnd = start === end ? nextGraphemeOffset(value, focus) : end;
			replaceRange(target, start, deleteEnd, "", start);
			return true;
		}
		case "e":
			moveSelection(target, lineEnd(value, focus), extend);
			return true;
		case "f":
			moveSelection(target, !extend && start !== end ? end : nextGraphemeOffset(value, focus), extend);
			return true;
		case "h": {
			const deleteStart = start === end ? previousGraphemeOffset(value, focus) : start;
			replaceRange(target, deleteStart, end, "", deleteStart);
			return true;
		}
		case "k": {
			let deleteEnd = lineEnd(value, focus);
			if (deleteEnd === focus && deleteEnd < value.length) deleteEnd += 1;
			replaceRange(target, start, Math.max(end, deleteEnd), "", start);
			return true;
		}
		case "n":
			moveSelection(target, verticalOffset(value, focus, "next"), extend);
			return true;
		case "p":
			moveSelection(target, verticalOffset(value, focus, "previous"), extend);
			return true;
		case "t":
			transposeAtCaret(target, focus);
			return true;
		default:
			return false;
	}
}
