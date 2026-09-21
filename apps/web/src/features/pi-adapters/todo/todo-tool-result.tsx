import type { ToolResultSessionMessage } from "@ling/contracts/session";
import { isTodoOrigin, todoDetailsSchema, type TodoDetails } from "@ling/contracts/todo";
import { Button } from "@renderer/components/ui/button";
import { useFeatureNavigation } from "@renderer/components/workbench/feature-navigation";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { TodoTasks } from "./todo-tasks";

function todoDetails(message: ToolResultSessionMessage): TodoDetails | null {
	if (message.toolName !== "todo" || !isTodoOrigin(message.toolOrigin ?? null)) return null;
	const parsed = todoDetailsSchema.safeParse(message.details);
	return parsed.success ? parsed.data : null;
}

/** Shows rpiv-todo results as a checklist and keeps Pi's own rendering one click away. */
export function TodoToolResult({ message, children }: { message: ToolResultSessionMessage; children: ReactNode }) {
	const details = todoDetails(message);
	return details ? <TodoChecklist details={details}>{children}</TodoChecklist> : children;
}

function TodoChecklist({ details, children }: { details: TodoDetails; children: ReactNode }) {
	const { t } = useTranslation();
	const openFeature = useFeatureNavigation();
	return (
		<div className="flex min-w-0 flex-col gap-2 text-sm">
			<TodoTasks
				value={details}
				compact
				more={
					<Button variant="ghost" size="sm" className="mt-2 self-start" onClick={() => openFeature("todo")}>
						{t("todo.viewAll")}
					</Button>
				}
			/>
			<details className="text-xs text-text-muted">
				<summary className="cursor-default">{t("todo.originalResult")}</summary>
				<div className="mt-2">{children}</div>
			</details>
		</div>
	);
}
