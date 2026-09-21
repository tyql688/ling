import { INTERFACE_ZOOM_PERCENTS } from "@ling/contracts/application";
import { sharedPreferenceAtom } from "@renderer/lib/user-state/state";
import { readUiBootPreferences } from "./boot-preferences";

export type InterfaceZoomChoice = `${(typeof INTERFACE_ZOOM_PERCENTS)[number]}`;
export const INTERFACE_ZOOM_CHOICES = INTERFACE_ZOOM_PERCENTS.map((percent) => String(percent) as InterfaceZoomChoice);
export const interfaceZoomAtom = sharedPreferenceAtom("interfaceZoom", readUiBootPreferences()?.interfaceZoom ?? "100");
/** Automatic follows display density; the other choices request a particular text rendering style. */
export type FontSmoothingChoice = "automatic" | "antialiased" | "system";
export const FONT_SMOOTHING_CHOICES: readonly FontSmoothingChoice[] = ["automatic", "antialiased", "system"];
export const fontSmoothingAtom = sharedPreferenceAtom(
	"fontSmoothing",
	readUiBootPreferences()?.fontSmoothing ?? "automatic",
);
/** Seventy percent leaves a thirty percent tint above native glass. */
export const nativeTransparencyAtom = sharedPreferenceAtom(
	"nativeTransparency",
	readUiBootPreferences()?.nativeTransparency ?? 70,
);
