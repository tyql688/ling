import type { SkinAppearanceMode } from "@ling/contracts/skins";
import { themePreferenceAtom, type ThemePreference } from "@renderer/lib/appearance/theme-state";
import { useAtom } from "jotai";
import { useSyncExternalStore } from "react";

const media = window.matchMedia("(prefers-color-scheme: dark)");

export interface ThemeController {
	/** Saved studio preference survives visits to fixed artwork designs. */
	preference: ThemePreference;
	setPreference: (preference: ThemePreference) => void;
	studioAppearance: SkinAppearanceMode;
	switchable: boolean;
}

export function useTheme() {
	const [preference, setPreference] = useAtom(themePreferenceAtom);
	const prefersDark = useSyncExternalStore(
		(onChange) => {
			media.addEventListener("change", onChange);
			return () => media.removeEventListener("change", onChange);
		},
		() => media.matches,
	);
	const appearance: SkinAppearanceMode =
		preference === "dark" || (preference === "system" && prefersDark) ? "dark" : "light";
	// The skin applier commits the effective class and palette together after artwork selection.
	return { preference, setPreference, appearance };
}
