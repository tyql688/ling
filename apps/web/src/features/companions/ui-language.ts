import { UI_LANGUAGES, type UiLanguage } from "@ling/contracts/application";
import type { i18n } from "i18next";

/** The renderer's resolved language when it is one Ling ships; the Host falls back to English otherwise. */
export function uiLanguage(instance: i18n): UiLanguage | undefined {
	const language = instance.resolvedLanguage ?? instance.language;
	return UI_LANGUAGES.find((candidate) => candidate === language);
}
