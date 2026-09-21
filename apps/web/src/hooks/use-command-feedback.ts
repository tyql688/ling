import { useAppFeedback } from "@renderer/lib/feedback-context";
import { formatRequestError } from "@renderer/lib/errors";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";

/** Workspace operations and independently owned panels share one visible failure channel. */
export function useCommandFeedback() {
	const { t } = useTranslation();
	const { show } = useAppFeedback();
	return useCallback(
		(error: unknown) =>
			show({ tone: "danger", title: formatRequestError(error, t), dedupeKey: "workspace-operation-error" }),
		[show, t],
	);
}
