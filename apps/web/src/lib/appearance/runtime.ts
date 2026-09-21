import i18next from "i18next";
import type { LingApi } from "@ling/contracts/api/ling-api";
import { errorMessage } from "@ling/contracts/ling-error";
import type { createStore } from "jotai/vanilla";
import { dataIssuesAtom } from "../data-health/state";
import { userStateAtom, userStateStatusAtom } from "../user-state/state";
import { UI_BOOT_PREFERENCES_KEY } from "./boot-preferences";
import { fontSmoothingAtom, interfaceZoomAtom, nativeTransparencyAtom } from "./window-state";

/** Renderer bootstrap owns native preference effects and their late-result fences. */
export function createAppearanceRuntime(store: ReturnType<typeof createStore>, api: LingApi["window"]) {
	let disposed = false,
		revision = 0;
	let savedCache: string | null = null,
		appliedZoom: string | null = null;
	async function applyZoom(zoom: string) {
		const request = ++revision;
		try {
			await api.setZoomFactor(Number(zoom) / 100);
			if (disposed || request !== revision) return;
			store.set(dataIssuesAtom, (current) => {
				const next = { ...current };
				delete next["window:zoom"];
				return next;
			});
		} catch (error) {
			if (disposed || request !== revision) return;
			store.set(dataIssuesAtom, (current) => ({
				...current,
				["window:zoom"]: {
					label: i18next.t("settings.interfaceZoom"),
					message: errorMessage(error),
					retry: () => applyZoom(zoom),
				},
			}));
		}
	}
	function apply() {
		if (disposed || !store.get(userStateStatusAtom).ready) return;
		const preferences = store.get(userStateAtom).preferences;
		const transparency = store.get(nativeTransparencyAtom),
			smoothing = store.get(fontSmoothingAtom),
			zoom = store.get(interfaceZoomAtom);
		document.documentElement.style.setProperty("--native-transparency", String(transparency));
		document.documentElement.dataset.fontSmoothing = smoothing;
		if (appliedZoom !== zoom) {
			appliedZoom = zoom;
			void applyZoom(zoom);
		}
		const state = store.get(userStateStatusAtom);
		if (state.error || state.issues.length > 0) return;
		// An uncached native launch can choose its startup mark once the saved preference is known.
		document.documentElement.dataset.skinSelected = String((preferences.skin ?? "default") !== "default");
		const cache = JSON.stringify({
			version: 1,
			theme: preferences.theme ?? "system",
			skin: preferences.skin ?? "default",
			skinExpression: preferences.skinExpression ?? "balanced",
			nativeTransparency: transparency,
			fontSmoothing: smoothing,
			interfaceZoom: zoom,
			...(preferences.language ? { language: preferences.language } : {}),
		});
		if (savedCache === cache) return;
		try {
			localStorage.setItem(UI_BOOT_PREFERENCES_KEY, cache);
			savedCache = cache;
		} catch {
			/* A boot hint is disposable; shared preferences remain owned by the Host. */
		}
	}
	const releases = [store.sub(userStateAtom, apply), store.sub(userStateStatusAtom, apply)];
	apply();
	return {
		dispose() {
			disposed = true;
			revision++;
			for (const release of releases) release();
		},
	};
}
