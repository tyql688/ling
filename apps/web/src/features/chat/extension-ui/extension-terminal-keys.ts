/** Byte sequences for special keys sent to the PTY, including CSI function keys. */
const SPECIAL_KEY_DATA: Readonly<Record<string, string>> = {
	Escape: "\x1b",
	Enter: "\n",
	Tab: "\t",
	Backspace: "\x7f",
	Delete: "\x1b[3~",
	Insert: "\x1b[2~",
	Home: "\x1b[H",
	End: "\x1b[F",
	PageUp: "\x1b[5~",
	PageDown: "\x1b[6~",
	ArrowUp: "\x1b[A",
	ArrowDown: "\x1b[B",
	ArrowRight: "\x1b[C",
	ArrowLeft: "\x1b[D",
	F1: "\x1bOP",
	F2: "\x1bOQ",
	F3: "\x1bOR",
	F4: "\x1bOS",
};

/** CSI final bytes for arrow keys, composing sequences such as `\x1b[A`. */
const ARROW_CODE: Readonly<Record<string, string>> = {
	ArrowUp: "A",
	ArrowDown: "B",
	ArrowRight: "C",
	ArrowLeft: "D",
};

/** CSI numeric codes for function keys in the `\x1b[n~` family. */
const FUNCTION_KEY_CODE: Readonly<Record<string, string>> = {
	Insert: "2",
	Delete: "3",
	PageUp: "5",
	PageDown: "6",
	Home: "7",
	End: "8",
	F5: "15",
	F6: "17",
	F7: "18",
	F8: "19",
	F9: "20",
	F10: "21",
	F11: "23",
	F12: "24",
};

/** C0 control characters for Ctrl+symbol combinations, such as Ctrl+[ for ESC. */
const CONTROL_BY_SYMBOL: Readonly<Record<string, string>> = {
	"[": "\x1b",
	"\\": "\x1c",
	"]": "\x1d",
	"^": "\x1e",
	_: "\x1f",
};

interface ExtensionKeyboardEvent {
	key: string;
	keyCode?: number;
	altKey: boolean;
	ctrlKey: boolean;
	metaKey: boolean;
	shiftKey: boolean;
	isComposing?: boolean;
	nativeEvent?: { isComposing?: boolean; keyCode?: number };
}

function controlCharacter(key: string): string | null {
	if (key.length !== 1) return null;
	const lower = key.toLowerCase();
	if (lower >= "a" && lower <= "z") return String.fromCharCode(lower.charCodeAt(0) - 96);
	return CONTROL_BY_SYMBOL[key] ?? null;
}

function modifierValue(event: ExtensionKeyboardEvent): number {
	return 1 + (event.shiftKey ? 1 : 0) + (event.altKey ? 2 : 0) + (event.ctrlKey ? 4 : 0);
}

function modifiedArrowSequence(key: string, modifier: number): string | null {
	const code = Object.hasOwn(ARROW_CODE, key) ? ARROW_CODE[key] : undefined;
	return code ? `\x1b[1;${modifier}${code}` : null;
}

function modifiedFunctionSequence(key: string, modifier: number): string | null {
	if (/^F[1-4]$/.test(key)) return `\x1b[1;${modifier}${String.fromCharCode(79 + Number(key.slice(1)))}`;
	const code = Object.hasOwn(FUNCTION_KEY_CODE, key) ? FUNCTION_KEY_CODE[key] : undefined;
	return code ? `\x1b[${code};${modifier}~` : null;
}

/** Returns true for shortcut/control chords sent to extensions. Composer typing, Backspace, Enter, arrows and selection keys stay local to avoid IPC latency and IME delays. Composer extension shortcuts require a modifier, so unmodified push-to-talk bindings are unavailable there. Extension UI panels receive every key, including printable characters and arrows. */
export function isExtensionShortcutKey(event: ExtensionKeyboardEvent): boolean {
	if (event.ctrlKey || event.altKey) return true;
	if (event.key === "Escape") return true;
	if (/^F(?:[1-9]|1[0-2])$/.test(event.key)) return true;
	return event.shiftKey && event.key === "Tab";
}

export function extensionKeyData(event: ExtensionKeyboardEvent): string | null {
	const keyCode = event.nativeEvent?.keyCode ?? event.keyCode;
	if ((event.nativeEvent?.isComposing ?? event.isComposing) || keyCode === 229 || event.metaKey) return null;
	if (event.key === "Tab" && event.shiftKey) return "\x1b[Z";
	if (event.key === "Enter" && event.altKey) return "\x1b\n";
	if (event.key === "Enter" && event.shiftKey) return "\x1b[13;2u";
	if (event.key === "Backspace" && event.ctrlKey && !event.altKey) return "\x17";
	if (event.key === "Backspace" && event.altKey && !event.ctrlKey) return "\x1b\x7f";
	if (event.ctrlKey && event.altKey) {
		const modifier = modifierValue(event);
		const modified = modifiedArrowSequence(event.key, modifier) ?? modifiedFunctionSequence(event.key, modifier);
		if (modified) return modified;
	}
	if (event.ctrlKey) {
		const modifier = modifierValue(event);
		const control =
			modifiedArrowSequence(event.key, modifier) ??
			modifiedFunctionSequence(event.key, modifier) ??
			controlCharacter(event.key);
		if (control) return control;
	}
	if (event.altKey) {
		const modifier = modifierValue(event);
		const modified = modifiedArrowSequence(event.key, modifier) ?? modifiedFunctionSequence(event.key, modifier);
		if (modified) return modified;
		if (event.key.length === 1) return `\x1b${event.key}`;
	}
	if (event.shiftKey) {
		const modified = modifiedArrowSequence(event.key, 2) ?? modifiedFunctionSequence(event.key, 2);
		if (modified) return modified;
	}
	const special = Object.hasOwn(SPECIAL_KEY_DATA, event.key) ? SPECIAL_KEY_DATA[event.key] : undefined;
	const functionCode = Object.hasOwn(FUNCTION_KEY_CODE, event.key) ? FUNCTION_KEY_CODE[event.key] : undefined;
	return special ?? (functionCode ? `\x1b[${functionCode}~` : event.key.length === 1 ? event.key : null);
}
