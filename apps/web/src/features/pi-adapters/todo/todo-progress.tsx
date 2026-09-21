import type { SessionRef } from "@ling/contracts/session-ref";
import { todoProgress } from "@ling/contracts/todo";
import { Button } from "@renderer/components/ui/button";
import { useFeatureNavigation } from "@renderer/components/workbench/feature-navigation";
import { ListTodo } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useTodo } from "./use-todo";

/** Composer summary of the checklist; opens the todo page for this session. */
export function TodoProgress({ sessionRef }: { sessionRef: SessionRef }) {
	const { t } = useTranslation();
	const state = useTodo(sessionRef);
	const openFeature = useFeatureNavigation();
	const progress = state.value?.value ? todoProgress(state.value.value) : null;
	if (!progress?.total) return null;
	return (
		<Button
			variant="ghost"
			size="sm"
			className="h-7 shrink-0 gap-1 px-1.5 text-xs font-normal text-text-muted hover:text-text-primary"
			onClick={() => openFeature("todo")}
		>
			<ListTodo className="size-3.5" aria-hidden="true" />
			<span className="tabular-nums">
				{t("todo.title")} {progress.completed}/{progress.total}
			</span>
		</Button>
	);
}
