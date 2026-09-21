import type { LingApi } from "@ling/contracts/api/ling-api";
import { UI_LANGUAGES, type UiLanguage } from "@ling/contracts/application";
import { errorMessage } from "@ling/contracts/ling-error";
import { readUiBootPreferences } from "@renderer/lib/appearance/boot-preferences";
import { dataIssuesAtom } from "@renderer/lib/data-health/state";
import {
	initializeRendererPreferences,
	readRendererPreference,
	RENDERER_PREFERENCE_KEYS,
} from "@renderer/lib/preferences/renderer-preferences";
import { setRelativeTimeLocale } from "@renderer/lib/relative-time";
import { sharedPreferenceAtom, userStateAtom, userStateStatusAtom } from "@renderer/lib/user-state/state";
import i18next, { type LanguageDetectorModule } from "i18next";
import type { createStore } from "jotai/vanilla";
import { setDefaultI18nMap } from "markstream-react";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";
import ja from "./locales/ja.json";
import ko from "./locales/ko.json";
import zhCN from "./locales/zh-CN.json";

initializeRendererPreferences();

/** Ling owns persistence; i18next still chooses the best supported language from the full preference list. */
const rendererLanguageDetector: LanguageDetectorModule = {
	type: "languageDetector",
	detect() {
		const saved =
			readUiBootPreferences()?.language ??
			readRendererPreference<UiLanguage | null>(RENDERER_PREFERENCE_KEYS.language, null, (raw) =>
				UI_LANGUAGES.includes(raw as UiLanguage) ? (raw as UiLanguage) : null,
			).value;
		return [...(saved === null ? [] : [saved]), ...navigator.languages, navigator.language];
	},
};

await i18next
	.use(rendererLanguageDetector)
	.use(initReactI18next)
	.init({
		resources: {
			en: { translation: en },
			"zh-CN": { translation: zhCN },
			ja: { translation: ja },
			ko: { translation: ko },
		},
		fallbackLng: "en",
		supportedLngs: UI_LANGUAGES,
		interpolation: { escapeValue: false },
	});

function parseUiLanguage(language: string | undefined): UiLanguage {
	if (language === undefined || !UI_LANGUAGES.includes(language as UiLanguage)) {
		throw new Error(`Unsupported UI language: ${String(language)}`);
	}
	return language as UiLanguage;
}

function syncRendererLanguage(language: UiLanguage): void {
	document.documentElement.lang = language;
	setRelativeTimeLocale(language);
	setDefaultI18nMap({
		"common.copy": i18next.t("markdown.copy"),
		"common.copied": i18next.t("markdown.copied"),
		"common.decrease": i18next.t("markdown.decrease"),
		"common.reset": i18next.t("markdown.reset"),
		"common.increase": i18next.t("markdown.increase"),
		"common.expand": i18next.t("markdown.expand"),
		"common.collapse": i18next.t("markdown.collapse"),
		"common.preview": i18next.t("markdown.preview"),
		"common.source": i18next.t("markdown.source"),
		"common.export": i18next.t("markdown.export"),
		"common.open": i18next.t("markdown.open"),
		"common.close": i18next.t("markdown.close"),
		"common.zoomIn": i18next.t("markdown.zoomIn"),
		"common.zoomOut": i18next.t("markdown.zoomOut"),
		"common.resetZoom": i18next.t("markdown.resetZoom"),
		"image.loadError": i18next.t("markdown.imageNotAvailable"),
		"image.loading": i18next.t("markdown.imageLoading"),
	});
}

// Document semantics and relative timestamps follow the UI language at startup and on every switch.
const initialLanguage = parseUiLanguage(i18next.resolvedLanguage);
syncRendererLanguage(initialLanguage);
export const languagePreferenceAtom = sharedPreferenceAtom("language", initialLanguage);

export function createLocalizationRuntime(store: ReturnType<typeof createStore>, api: Pick<LingApi, "window" | "ui">) {
	let disposed = false,
		revision = 0,
		lastLanguage: UiLanguage | null = null;
	const listener = (language: string) => syncRendererLanguage(parseUiLanguage(language));
	i18next.on("languageChanged", listener);
	async function applyLanguage(nextLanguage: UiLanguage) {
		const request = ++revision;
		try {
			await i18next.changeLanguage(nextLanguage);
			if (disposed || request !== revision) return;
			if (api.ui.capabilities.nativeLanguageSync) await api.window.setLanguage(nextLanguage);
			if (disposed || request !== revision) return;
			store.set(dataIssuesAtom, (current) => {
				const next = { ...current };
				delete next["window:language"];
				return next;
			});
		} catch (error) {
			if (disposed || request !== revision) return;
			store.set(dataIssuesAtom, (current) => ({
				...current,
				["window:language"]: {
					label: i18next.t("settings.language"),
					message: errorMessage(error),
					retry: () => applyLanguage(nextLanguage),
				},
			}));
		}
	}
	const apply = () => {
		if (disposed || !store.get(userStateStatusAtom).ready) return;
		const language = store.get(languagePreferenceAtom);
		if (language === lastLanguage) return;
		lastLanguage = language;
		void applyLanguage(language);
	};
	const releases = [store.sub(userStateAtom, apply), store.sub(userStateStatusAtom, apply)];
	apply();
	return {
		dispose() {
			disposed = true;
			revision++;
			i18next.off("languageChanged", listener);
			for (const release of releases) release();
		},
	};
}
