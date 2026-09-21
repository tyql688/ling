import {
	RENDERER_PREFERENCE_KEYS,
	readRendererPreference,
	writeRendererPreference,
} from "@renderer/lib/preferences/renderer-preferences";
import { atom } from "jotai";

/** Sidebar collapsed-state preference key; same source as the renderer-preferences table — renaming it loses user preference. */
const SIDEBAR_STORAGE_KEY = RENDERER_PREFERENCE_KEYS.sidebarCollapsed;

const baseSidebarCollapsedAtom = atom<boolean>(
	readRendererPreference(SIDEBAR_STORAGE_KEY, false, (raw) => (raw === "1" ? true : raw === "0" ? false : null)).value,
);

export const sidebarCollapsedAtom = atom(
	(get) => get(baseSidebarCollapsedAtom),
	(_get, set, value: boolean) => {
		set(baseSidebarCollapsedAtom, value);
		writeRendererPreference(SIDEBAR_STORAGE_KEY, value ? "1" : "0");
	},
);
