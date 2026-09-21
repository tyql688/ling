import type {
	SkinAppearanceMode,
	SkinCodeTheme,
	SkinManifest,
	SkinPalette,
	UserSkinsSnapshot,
} from "@ling/contracts/skins";
import type { SkinSceneOverride } from "@ling/contracts/user-state";
import { mutateUserStateAtom, sharedPreferenceAtom, userStateAtom } from "@renderer/lib/user-state/state";
import { atom } from "jotai";
import { readUiBootPreferences } from "./boot-preferences";

/** "default", "builtin:<id>", or "custom:<package-id>". The Host owns each saved selection. */
export type SkinPreference = string;
export const skinPreferenceAtom = sharedPreferenceAtom("skin", readUiBootPreferences()?.skin ?? "default");
export const skinExpressionAtom = sharedPreferenceAtom(
	"skinExpression",
	readUiBootPreferences()?.skinExpression ?? "balanced",
);
export const skinSceneOverridesAtom = atom(
	(get) => get(userStateAtom).skinScenes,
	(_get, set, update: { preference: SkinPreference; scene: SkinSceneOverride | null }) =>
		set(mutateUserStateAtom, [{ type: "skinScene", key: update.preference, scene: update.scene }]),
);

interface ActiveSkinAppearance {
	appearance: SkinAppearanceMode;
	motion: SkinManifest["presentation"]["motion"];
	codeTheme: SkinCodeTheme;
	palette: SkinPalette;
	/** Opaque source colors for editor widgets and syntax contrast, before artwork compositing. */
	codeSurface: string;
	popoverSurface: string;
}

const DEFAULT_LIGHT_PALETTE: SkinPalette = {
	canvas: "#f2f2f3",
	surface: "#ffffff",
	text: "#1a1a1d",
	accent: "#006dd3",
	secondary: "#0f766e",
};

const DEFAULT_DARK_PALETTE: SkinPalette = {
	canvas: "#0d0d0f",
	surface: "#19191c",
	text: "#f5f5f7",
	accent: "#5aa7ff",
	secondary: "#82d4c8",
};

export const activeSkinAppearanceAtom = atom<ActiveSkinAppearance>({
	appearance: document.documentElement.classList.contains("dark") ? "dark" : "light",
	// The default skin uses subtle motion when no boot preference exists.
	motion: document.documentElement.dataset.skinMotion === "none" ? "none" : "subtle",
	codeTheme: "neutral",
	palette: document.documentElement.classList.contains("dark") ? DEFAULT_DARK_PALETTE : DEFAULT_LIGHT_PALETTE,
	codeSurface: document.documentElement.classList.contains("dark")
		? DEFAULT_DARK_PALETTE.surface
		: DEFAULT_LIGHT_PALETTE.surface,
	popoverSurface: document.documentElement.classList.contains("dark")
		? DEFAULT_DARK_PALETTE.surface
		: DEFAULT_LIGHT_PALETTE.surface,
});

/** Latest listing of ~/.ling/skins; null until the first main-process read resolves. */
export const userSkinsAtom = atom<UserSkinsSnapshot | null>(null);
export const skinLoadErrorAtom = atom<string | null>(null);
