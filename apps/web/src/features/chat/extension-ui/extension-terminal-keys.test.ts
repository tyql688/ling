import { expect, it } from "vitest";
import { extensionKeyData, isExtensionShortcutKey } from "./extension-terminal-keys";

it("routes Pi function-key bindings as terminal input, including modifiers", () => {
	const event = { key: "F8", altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };
	expect(isExtensionShortcutKey(event)).toBe(true);
	expect(extensionKeyData(event)).toBe("\x1b[19~");
	expect(extensionKeyData({ ...event, shiftKey: true })).toBe("\x1b[19;2~");
	expect(extensionKeyData({ ...event, key: "F1" })).toBe("\x1bOP");
	expect(extensionKeyData({ ...event, key: "F4", ctrlKey: true })).toBe("\x1b[1;5S");
	expect(extensionKeyData({ ...event, key: "F12", altKey: true })).toBe("\x1b[24;3~");
});

it("keeps ordinary composer editing local and ignores composing input", () => {
	const event = { key: "a", altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };
	for (const key of ["a", "Enter", "Backspace", "ArrowLeft"])
		expect(isExtensionShortcutKey({ ...event, key })).toBe(false);
	expect(extensionKeyData({ ...event, key: "F8", isComposing: true })).toBeNull();
});
