import { unsupportedExtensionUi as unsupported } from "../../pi-protocol/extension-ui";

/** Pi TUI default keybinding table; the GUI's display/matching fallback when no custom bindings exist, aligned with CLI key semantics. */
const DEFAULT_KEYBINDINGS: Record<string, readonly string[]> = {
	"tui.editor.cursorUp": ["up"],
	"tui.editor.cursorDown": ["down"],
	"tui.editor.cursorLeft": ["left", "ctrl+b"],
	"tui.editor.cursorRight": ["right", "ctrl+f"],
	"tui.editor.cursorWordLeft": ["alt+left", "ctrl+left", "alt+b"],
	"tui.editor.cursorWordRight": ["alt+right", "ctrl+right", "alt+f"],
	"tui.editor.cursorLineStart": ["home", "ctrl+a"],
	"tui.editor.cursorLineEnd": ["end", "ctrl+e"],
	"tui.editor.pageUp": ["pageUp"],
	"tui.editor.pageDown": ["pageDown"],
	"tui.editor.deleteCharBackward": ["backspace"],
	"tui.editor.deleteCharForward": ["delete", "ctrl+d"],
	"tui.editor.deleteWordBackward": ["ctrl+w", "alt+backspace"],
	"tui.editor.deleteWordForward": ["alt+d", "alt+delete"],
	"tui.editor.deleteToLineStart": ["ctrl+u"],
	"tui.editor.deleteToLineEnd": ["ctrl+k"],
	"tui.editor.yank": ["ctrl+y"],
	"tui.editor.yankPop": ["alt+y"],
	"tui.editor.undo": ["ctrl+-"],
	"tui.input.newLine": ["shift+enter", "ctrl+j"],
	"tui.input.submit": ["enter"],
	"tui.input.tab": ["tab"],
	"tui.input.copy": ["ctrl+c"],
	"tui.select.up": ["up"],
	"tui.select.down": ["down"],
	"tui.select.pageUp": ["pageUp"],
	"tui.select.pageDown": ["pageDown"],
	"tui.select.confirm": ["enter"],
	"tui.select.cancel": ["escape", "ctrl+c"],
	"app.interrupt": ["escape"],
	"app.clear": ["ctrl+c"],
	"app.exit": ["ctrl+d"],
	"app.thinking.cycle": ["shift+tab"],
	"app.model.cycleForward": ["ctrl+p"],
	"app.model.cycleBackward": ["ctrl+shift+p"],
	"app.model.select": ["ctrl+l"],
	"app.tools.expand": ["ctrl+o"],
	"app.thinking.toggle": ["ctrl+t"],
	"app.editor.external": ["ctrl+g"],
	"app.message.followUp": ["alt+enter"],
	"app.message.dequeue": ["alt+up"],
	"app.clipboard.pasteImage": [process.platform === "win32" ? "alt+v" : "ctrl+v"],
	"app.tree.foldOrUp": ["ctrl+left", "alt+left"],
	"app.tree.unfoldOrDown": ["ctrl+right", "alt+right"],
	"app.tree.editLabel": ["shift+l"],
	"app.tree.toggleLabelTimestamp": ["shift+t"],
	"app.tree.filter.default": ["ctrl+d"],
	"app.tree.filter.noTools": ["ctrl+t"],
	"app.tree.filter.userOnly": ["ctrl+u"],
	"app.tree.filter.labeledOnly": ["ctrl+l"],
	"app.tree.filter.all": ["ctrl+a"],
	"app.tree.filter.cycleForward": ["ctrl+o"],
	"app.tree.filter.cycleBackward": ["ctrl+shift+o"],
	"app.models.save": ["ctrl+s"],
	"app.models.enableAll": ["ctrl+a"],
	"app.models.clearAll": ["ctrl+x"],
	"app.models.toggleProvider": ["ctrl+p"],
	"app.models.reorderUp": ["alt+up"],
	"app.models.reorderDown": ["alt+down"],
	"app.session.toggleNamedFilter": ["ctrl+n"],
	"app.session.togglePath": ["ctrl+p"],
	"app.session.toggleSort": ["ctrl+s"],
	"app.session.rename": ["ctrl+r"],
	"app.session.delete": ["ctrl+d"],
	"app.session.deleteNoninvasive": ["ctrl+backspace"],
};

/** Raw terminal byte sequences → canonical key names; covers legacy CSI/control-character descriptions. */
const LEGACY_KEY_DATA: Record<string, string> = {
	"\x1b": "escape",
	"\t": "tab",
	"\n": "enter",
	"\r": "enter",
	" ": "space",
	"\x7f": "backspace",
	"\x1b[A": "up",
	"\x1b[B": "down",
	"\x1b[C": "right",
	"\x1b[D": "left",
	"\x1b[H": "home",
	"\x1b[F": "end",
	"\x1b[1~": "home",
	"\x1b[4~": "end",
	"\x1b[2~": "insert",
	"\x1b[3~": "delete",
	"\x1b[5~": "pageUp",
	"\x1b[6~": "pageDown",
	"\x1b\x7f": "alt+backspace",
	"\x1bb": "alt+left",
	"\x1bf": "alt+right",
	"\x1bp": "alt+up",
	"\x1bn": "alt+down",
};

/** CSI arrow letter codes → arrow key names (A/B/C/D per the xterm standard). */
const ARROW_KEY_BY_CODE: Record<string, string> = { A: "up", B: "down", C: "right", D: "left" };
/** CSI ~ function-key numeric codes → key names (insert/delete/page/home/end). */
const FUNCTION_KEY_BY_CODE: Record<string, string> = {
	"2": "insert",
	"3": "delete",
	"5": "pageUp",
	"6": "pageDown",
	"7": "home",
	"8": "end",
};
/** CSI u protocol key codes → canonical key names (kitty/modifyOtherKeys style). */
const CSI_U_KEY_BY_CODE: Record<string, string> = {
	"9": "tab",
	"13": "enter",
	"27": "escape",
	"32": "space",
	"127": "backspace",
};

function unsupportedUnknownProperty(target: object, ownerCapability: string, capability: string): object {
	return new Proxy(target, {
		get(value, property, receiver) {
			if (typeof property === "symbol") return Reflect.get(value, property, receiver);
			if (Object.hasOwn(value, property)) return Reflect.get(value, property, receiver);
			unsupported(`${ownerCapability}.${capability}.${property}`);
		},
	});
}

function defaultKeysFor(keybinding: string): readonly string[] {
	if (!Object.hasOwn(DEFAULT_KEYBINDINGS, keybinding)) return [];
	return DEFAULT_KEYBINDINGS[keybinding] ?? [];
}

function cloneDefaultKeybindings(): Record<string, readonly string[]> {
	return Object.fromEntries(Object.entries(DEFAULT_KEYBINDINGS).map(([key, bindings]) => [key, [...bindings]]));
}

function modifierPrefix(modifierValue: number): string {
	const modifier = modifierValue - 1;
	const parts: string[] = [];
	if ((modifier & 4) !== 0) parts.push("ctrl");
	if ((modifier & 2) !== 0) parts.push("alt");
	if ((modifier & 1) !== 0) parts.push("shift");
	if ((modifier & 8) !== 0) parts.push("super");
	return parts.length === 0 ? "" : `${parts.join("+")}+`;
}

function csiUCodePointKey(codePoint: number): string | undefined {
	if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return undefined;
	return String.fromCodePoint(codePoint);
}

function keyIdsFromData(data: string): string[] {
	const direct = Object.hasOwn(LEGACY_KEY_DATA, data) ? LEGACY_KEY_DATA[data] : undefined;
	if (direct) return [direct];
	if (data.startsWith("\x1b[1;")) {
		const code = data.at(-1);
		const key = code ? ARROW_KEY_BY_CODE[code] : undefined;
		const modifier = data.slice(4, -1);
		if (key && modifier.length > 0) return [`${modifierPrefix(Number.parseInt(modifier, 10))}${key}`];
	}
	if (data.startsWith("\x1b[") && data.endsWith("~")) {
		const [keyCode, modifier] = data.slice(2, -1).split(";");
		const key = keyCode ? FUNCTION_KEY_BY_CODE[keyCode] : undefined;
		if (key) return [`${modifierPrefix(Number.parseInt(modifier ?? "1", 10))}${key}`];
	}
	if (data.startsWith("\x1b[") && data.endsWith("u")) {
		const [code, modifier] = data.slice(2, -1).split(";");
		const parsedCode = code === undefined ? Number.NaN : Number.parseInt(code, 10);
		const parsedModifier = modifier === undefined ? Number.NaN : Number.parseInt(modifier, 10);
		const key = code === undefined ? undefined : (CSI_U_KEY_BY_CODE[code] ?? csiUCodePointKey(parsedCode));
		if (key && Number.isInteger(parsedModifier)) return [`${modifierPrefix(parsedModifier)}${key}`];
	}
	const charCode = data.length === 1 ? data.charCodeAt(0) : 0;
	if (charCode >= 1 && charCode <= 26) return [`ctrl+${String.fromCharCode(charCode + 96)}`];
	if (data.length === 2 && data.startsWith("\x1b")) return [`alt+${data[1]}`];
	if (data.length === 1) return [data];
	return [];
}

export function createLingKeybindings(): unknown {
	const bindings = {
		matches(data: string, keybinding: string): boolean {
			const keys = defaultKeysFor(keybinding);
			if (keys.length === 0) return false;
			const ids = keyIdsFromData(data);
			return keys.some((key) => ids.includes(key));
		},
		getKeys(keybinding: string): string[] {
			return [...defaultKeysFor(keybinding)];
		},
		getDefinition(keybinding: string) {
			return { defaultKeys: [...defaultKeysFor(keybinding)] };
		},
		getConflicts(): unknown[] {
			return [];
		},
		getUserBindings(): Record<string, never> {
			return {};
		},
		getResolvedBindings(): Record<string, readonly string[]> {
			return cloneDefaultKeybindings();
		},
		getEffectiveConfig(): Record<string, readonly string[]> {
			return cloneDefaultKeybindings();
		},
		setUserBindings() {
			unsupported("custom.keybindings.setUserBindings");
		},
		reload() {
			unsupported("custom.keybindings.reload");
		},
	};
	return unsupportedUnknownProperty(bindings, "custom", "keybindings");
}
