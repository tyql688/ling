import type { PiResourceReloadSummary } from "@ling/contracts/session";
import { useAppFeedback } from "@renderer/lib/feedback-context";
import { summarizePiResourceReload } from "@renderer/lib/resource-reload";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";

export function ResourceReloadFeedback({
	summary,
	successMessage,
}: {
	summary: PiResourceReloadSummary;
	successMessage?: string;
}) {
	const { t } = useTranslation();
	const feedback = useAppFeedback();
	const status = summarizePiResourceReload(summary);

	useEffect(() => {
		// A distinct reload result must restart/replace the toast even when its
		// aggregate status happens to match the previous result.
		void summary;
		feedback.show({
			tone: status === "error" ? "danger" : status === "deferred" ? "warning" : "success",
			title: status === "success" && successMessage ? successMessage : t(`resourceReload.${status}`),
			dedupeKey: "pi-resource-reload",
		});
	}, [feedback, status, summary, successMessage, t]);

	return null;
}
