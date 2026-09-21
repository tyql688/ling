import type { QuestionRecord } from "@ling/contracts/questions";
import { sessionKey, type SessionRef } from "@ling/contracts/session-ref";
import { Button } from "@renderer/components/ui/button";
import { FeedbackNotice } from "@renderer/components/ui/feedback";
import { PanelPage } from "@renderer/components/ui/panel-page";
import { useFeatureSnapshot } from "@renderer/features/companions/use-feature-snapshot";
import { useDomainApi } from "@renderer/lib/host-api-context";
import { useTranslation } from "react-i18next";
import { BuiltinFeatureNotice } from "@renderer/features/companions/builtin-features";

export function QuestionsPage({ sessionRef }: { sessionRef: SessionRef }) {
	const { t } = useTranslation();
	const api = useDomainApi("questions");
	const key = sessionKey(sessionRef);
	const state = useFeatureSnapshot<QuestionRecord[]>({
		load: () => api.list(sessionRef),
		subscribe: (refresh) => api.onChanged((ref) => (ref === null || sessionKey(ref) === key) && refresh()),
		key,
	});
	return (
		<PanelPage title={t("questions.title")}>
			<BuiltinFeatureNotice id="questions" />
			{state.error && <FeedbackNotice tone="danger">{state.error}</FeedbackNotice>}
			<p className="text-xs text-text-muted">{t("questions.hint")}</p>
			{state.value?.length === 0 && <p className="text-xs text-text-muted">{t("questions.empty")}</p>}
			{state.value
				?.slice()
				.reverse()
				.map((item) => (
					<div key={item.id} className="flex flex-col gap-2.5 border-b border-border-subtle py-4">
						<span className="font-medium">{item.title}</span>
						<span className="text-xs text-text-muted">{t(`questions.status.${item.status}`)}</span>
						{item.answer?.answers.map((answer) => {
							const question = item.questions.find((q) => q.id === answer.id);
							return (
								<div key={answer.id} className="flex flex-col gap-1">
									<span>{question?.title ?? answer.id}</span>
									<span className="whitespace-pre-wrap text-text-secondary">
										{[
											...answer.selected.map(
												(id) => question?.options?.find((option) => option.id === id)?.label ?? id,
											),
											answer.text,
										]
											.filter(Boolean)
											.join("\n")}
									</span>
								</div>
							);
						})}
						{item.error && (
							<FeedbackNotice tone="danger" className="text-xs">
								{item.error}
							</FeedbackNotice>
						)}
						{item.delivery === "failed" && (
							<Button
								variant="outline"
								size="sm"
								className="self-start"
								disabled={state.busy}
								onClick={() => void state.act(() => api.retry({ ref: sessionRef, id: item.id }))}
							>
								{t("questions.retryDelivery")}
							</Button>
						)}
					</div>
				))}
		</PanelPage>
	);
}
