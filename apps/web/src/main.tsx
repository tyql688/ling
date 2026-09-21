import { HostApiContext } from "@renderer/lib/host-api-context";
import { createAppearanceRuntime } from "@renderer/lib/appearance/runtime";
import { createLocalizationRuntime } from "./i18n/index";
import { createDataHealthRuntime } from "@renderer/lib/data-health/runtime";
import { createUserStatePersistence } from "@renderer/lib/user-state/persistence";
import { ErrorBoundary } from "@renderer/components/error-boundary";
import { AppErrorFallback } from "@renderer/components/error-fallback";
import { getRendererSessionResourceSnapshot } from "@renderer/features/sessions/runtime/renderer-session-state";
import { createSessionProjectionRuntime } from "@renderer/features/sessions/runtime/session-projection-runtime";
import { SessionProjectionContext } from "@renderer/features/sessions/runtime/session-projection-context";
import { createDraftPersistence } from "@renderer/features/sessions/state/draft-persistence";
import { getRendererPreferenceDiagnostics } from "@renderer/lib/preferences/renderer-preferences";
import { getDefaultStore } from "jotai/vanilla";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/app";
import "./i18n/index";
import "./index.css";

/** Bootstrap owns the renderer lifetime, including aborts during mounting and pagehide. */
export function mountApp(signal: AbortSignal): void {
	signal.throwIfAborted();
	const dataHealth = createDataHealthRuntime(getDefaultStore(), window.ling.data);
	signal.addEventListener("abort", dataHealth.dispose, { once: true });
	const userStatePersistence = createUserStatePersistence(getDefaultStore(), localStorage, window.ling.userState);
	signal.addEventListener("abort", userStatePersistence.dispose, { once: true });
	const appearance = createAppearanceRuntime(getDefaultStore(), window.ling.window);
	signal.addEventListener("abort", appearance.dispose, { once: true });
	const localization = createLocalizationRuntime(getDefaultStore(), window.ling);
	signal.addEventListener("abort", localization.dispose, { once: true });
	const draftPersistence = createDraftPersistence(
		getDefaultStore(),
		{
			getItem: (key) => localStorage.getItem(key),
			setItem: (key, value) => localStorage.setItem(key, value),
			removeItem: (key) => localStorage.removeItem(key),
		},
		window.ling.draft,
	);
	signal.addEventListener("abort", draftPersistence.dispose, { once: true });
	const flushHiddenDrafts = () => {
		if (document.visibilityState === "hidden") {
			void draftPersistence.flush();
			void userStatePersistence.flush();
		}
	};
	document.addEventListener("visibilitychange", flushHiddenDrafts);
	signal.addEventListener("abort", () => document.removeEventListener("visibilitychange", flushHiddenDrafts), {
		once: true,
	});
	const projection = createSessionProjectionRuntime(getDefaultStore(), window.ling.session);
	signal.addEventListener("abort", projection.dispose, { once: true });

	if (import.meta.env.DEV) {
		// React development timing entries accumulate during streaming. DevTools observes them
		// at emission, so periodically releasing them avoids retaining the entire render history.
		const USER_TIMING_DRAIN_MS = 10_000;
		const timer = setInterval(() => {
			performance.clearMeasures();
			performance.clearMarks();
		}, USER_TIMING_DRAIN_MS);
		signal.addEventListener("abort", () => clearInterval(timer), { once: true });
		Reflect.set(
			window,
			Symbol.for("ling.devDiagnostics"),
			Object.freeze({
				rendererSessionResources: () => getRendererSessionResourceSnapshot(getDefaultStore()),
				rendererPreferenceDiagnostics: () => getRendererPreferenceDiagnostics(),
			}),
		);
	}

	const container = document.getElementById("root");
	if (!container) throw new Error("Missing #root element");
	const root = createRoot(container);
	signal.addEventListener("abort", () => root.unmount(), { once: true });
	void userStatePersistence.ready.then(() => {
		if (signal.aborted) return;
		root.render(
			<StrictMode>
				<ErrorBoundary fallback={(error) => <AppErrorFallback error={error} />}>
					<SessionProjectionContext value={projection.refresh}>
						<HostApiContext value={window.ling}>
							<App />
						</HostApiContext>
					</SessionProjectionContext>
				</ErrorBoundary>
			</StrictMode>,
		);
	});
	const startupFrame = requestAnimationFrame(() => document.body.classList.add("ling-startup-ready"));
	signal.addEventListener("abort", () => cancelAnimationFrame(startupFrame), { once: true });
}
