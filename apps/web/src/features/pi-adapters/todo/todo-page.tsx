import type { SessionRef } from "@ling/contracts/session-ref";
import { todoProgress } from "@ling/contracts/todo";
import { Button } from "@renderer/components/ui/button";
import { FeedbackNotice } from "@renderer/components/ui/feedback";
import { PanelPage } from "@renderer/components/ui/panel-page";
import { useDomainApi } from "@renderer/lib/host-api-context";
import { Check, Square } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { TodoTasks } from "./todo-tasks";
import { useTodo } from "./use-todo";
import { uiLanguage } from "@renderer/features/companions/ui-language";
import { BuiltinFeatureNotice } from "@renderer/features/companions/builtin-features";
import { useBuiltinFeatures } from "@renderer/features/companions/builtin-feature-state";

export function TodoPage({ sessionRef }: { sessionRef: SessionRef }) {
	const { t, i18n } = useTranslation();
	const api = useDomainApi("todo");
	const state = useTodo(sessionRef);
	const enabled = useBuiltinFeatures().value?.enabled.todo === true;
	const [requestId, setRequestId] = useState(() => crypto.randomUUID());
	const progress = state.value?.value ? todoProgress(state.value.value) : null;
	return (
		<PanelPage title={t("todo.title")}>
			<BuiltinFeatureNotice id="todo" />
			{state.error && <FeedbackNotice tone="danger">{state.error}</FeedbackNotice>}
			{!!progress?.open.length && !state.sessionBusy && (
				<div className="flex flex-wrap items-center gap-3 border-y border-border-subtle py-3.5">
					<div className="flex min-w-0 flex-1 flex-col gap-1">
						<span>{t("todo.unfinishedTitle")}</span>
						<span className="text-xs text-text-muted">{t("todo.unfinishedDescription")}</span>
					</div>
					<Button
						variant="outline"
						size="sm"
						disabled={state.busy || !enabled}
						onClick={() =>
							void state.act(
								() => api.review({ ref: sessionRef, requestId, language: uiLanguage(i18n) }),
								() => setRequestId(crypto.randomUUID()),
							)
						}
					>
						{t(state.busy ? "todo.checking" : "todo.checkProgress")}
					</Button>
				</div>
			)}
			{state.value?.value ? (
				<TodoTasks value={state.value.value} />
			) : (
				state.value && <p className="text-xs text-text-muted">{t("todo.empty")}</p>
			)}
			{!!state.value?.legacy?.length && (
				<details className="text-sm">
					<summary className="cursor-default text-text-muted">{t("todo.legacy")}</summary>
					{state.value.legacy.map((task) => (
						<div key={task.id} className="flex items-center gap-2.5 border-b border-border-subtle py-3">
							{task.status === "done" ? (
								<Check className="size-[15px] text-text-muted" aria-hidden="true" />
							) : (
								<Square className="size-[15px] text-text-muted" aria-hidden="true" />
							)}
							<span>{task.title}</span>
						</div>
					))}
				</details>
			)}
		</PanelPage>
	);
}
