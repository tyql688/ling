import { Button } from "@renderer/components/ui/button";
import { FeedbackNotice } from "@renderer/components/ui/feedback";
import { useTranslation } from "react-i18next";
import type { TranscriptHistoryLoad } from "./use-transcript-history";

/** Shows page-load failures beside retained messages and keeps the incomplete-history status visible. */
export function TranscriptHistoryNotice({ history }: { history: TranscriptHistoryLoad }) {
	const { t } = useTranslation();
	if (history.error === null && !history.loading) return null;
	return (
		<FeedbackNotice
			tone={history.error === null ? "info" : "warning"}
			title={t(history.loading ? "session.loadingEarlierMessages" : "session.historyLoadFailed")}
			className="mx-3 my-2 shrink-0"
			action={
				history.error === null ? undefined : (
					<Button size="sm" variant="outline" disabled={history.loading} onClick={history.retry}>
						{t("session.retryHistoryLoad")}
					</Button>
				)
			}
		>
			{history.error}
		</FeedbackNotice>
	);
}
