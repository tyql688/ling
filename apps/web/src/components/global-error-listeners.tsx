import { useAppFeedback } from "@renderer/lib/feedback-context";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";

function describeUnknown(value: unknown): string {
	if (value instanceof Error) return value.message;
	return String(value);
}

export function GlobalErrorListeners() {
	const { show: showFeedback } = useAppFeedback();
	const { t } = useTranslation();
	useEffect(() => {
		const onError = (event: ErrorEvent) => {
			// Chromium reports this when layout settles across a frame; nothing failed.
			if (/ResizeObserver loop/u.test(event.message)) return;
			console.error("Uncaught renderer error", event.error ?? event.message);
			showFeedback({
				tone: "danger",
				title: t("errorBoundary.globalErrorTitle"),
				description: describeUnknown(event.error ?? event.message),
				dedupeKey: `uncaught:${event.message}`,
			});
		};
		const onRejection = (event: PromiseRejectionEvent) => {
			console.error("Unhandled promise rejection", event.reason);
			showFeedback({
				tone: "danger",
				title: t("errorBoundary.globalErrorTitle"),
				description: describeUnknown(event.reason),
				dedupeKey: `unhandled-rejection:${describeUnknown(event.reason)}`,
			});
		};
		window.addEventListener("error", onError);
		window.addEventListener("unhandledrejection", onRejection);
		return () => {
			window.removeEventListener("error", onError);
			window.removeEventListener("unhandledrejection", onRejection);
		};
	}, [showFeedback, t]);
	return null;
}
