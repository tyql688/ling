import { sharedPreferenceAtom } from "@renderer/lib/user-state/state";
import { readUiBootPreferences } from "./boot-preferences";
export type ThemePreference = "system" | "light" | "dark";
export const themePreferenceAtom = sharedPreferenceAtom("theme", readUiBootPreferences()?.theme ?? "system");
