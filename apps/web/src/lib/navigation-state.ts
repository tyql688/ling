import { atom } from "jotai";

type AppMode = "workspace" | "settings";

export const appModeAtom = atom<AppMode>("workspace");

/** Which settings category is showing; an atom so other surfaces, such as the model connection prompt, can deep-link. */
export type SettingsCategory =
	| "general"
	| "appearance"
	| "terminal"
	| "pi"
	| "models"
	| "plugins"
	| "mcp"
	| "skills"
	| "permissions"
	| "usage"
	| "diagnostics";
export const settingsCategoryAtom = atom<SettingsCategory>("general");

/** Full-window feature pages that replace the workspace stage until closed. */
type AppPage = "schedules";
export const appPageAtom = atom<AppPage | null>(null);

/** Shared navigation into the existing Quickstart draft, including feature entry points. */
export const newConversationCwdAtom = atom<string | null>(null);
export const composerFocusRequestIdAtom = atom(0);
