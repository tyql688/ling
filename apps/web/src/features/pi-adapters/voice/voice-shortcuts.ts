import { isMac, shortcut } from "@renderer/lib/platform";

export const voiceShortcut = shortcut(isMac ? "⌥V" : "Alt+V");
export const voiceSettingsShortcut = shortcut(isMac ? "⇧⌥V" : "Shift+Alt+V");
