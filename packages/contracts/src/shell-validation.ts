import { z } from "zod";
import { INTERFACE_ZOOM_PERCENTS, UI_LANGUAGES } from "./application";

/** Shell navigation accepts only bounded HTTP(S) URLs; all other schemes remain internal. */
export const externalWebUrlSchema = z
	.string()
	.min(1)
	.max(4_096)
	.refine((value) => {
		try {
			const parsed = new URL(value);
			return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.hostname.length > 0;
		} catch {
			return false;
		}
	}, "External URL must be an http:// or https:// URL");
export const windowThemeSchema = z.strictObject({
	source: z.enum(["system", "light", "dark"]),
	/** Null uses platform ink until an authoritative skin mode is available. */
	foreground: z
		.string()
		.regex(/^#[0-9a-f]{6}$/i)
		.nullable(),
});
export const uiLanguageSchema = z.enum(UI_LANGUAGES);
export const windowZoomFactorSchema = z
	.number()
	.refine((value) => INTERFACE_ZOOM_PERCENTS.some((percent) => percent / 100 === value), "Unsupported zoom factor");
