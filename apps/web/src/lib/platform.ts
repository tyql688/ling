import type { AppPlatform } from "@ling/contracts/application";

export const appPlatform: AppPlatform = window.ling.env.platform;
export const isMac = appPlatform === "darwin";
export const isWindows = appPlatform === "win32";

/** Formats a shortcut with the platform's primary modifier. */
export function shortcut(key: string): string {
	return isMac ? `⌘${key}` : `Ctrl+${key}`;
}

export const modEnter = shortcut("Enter");

/** Accepts both modifier keys so external keyboards and synthetic events behave consistently. */
export function isShortcutModifier(event: { metaKey: boolean; ctrlKey: boolean }): boolean {
	return event.metaKey || event.ctrlKey;
}

/** Modifier fields for synthetic shortcut events. */
function shortcutModifierFields(): { metaKey: boolean; ctrlKey: boolean } {
	return isMac ? { metaKey: true, ctrlKey: false } : { metaKey: false, ctrlKey: true };
}

/** Opens the command palette from anywhere by replaying its own ⌘K/Ctrl+K shortcut. */
export function requestCommandPalette(): void {
	window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ...shortcutModifierFields() }));
}

/** Shared class names keep Electron window dragging out of component-local style objects. */
export const dragRegionClassName = "window-drag-region";
export const noDragRegionClassName = "window-no-drag-region";
