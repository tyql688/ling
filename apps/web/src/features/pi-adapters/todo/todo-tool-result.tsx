import type { ToolResultSessionMessage } from "@ling/contracts/session-messages";
import { isTodoOrigin, todoDetailsSchema, type TodoDetails } from "@ling/contracts/todo";
import { Button } from "@renderer/components/ui/button";
import { useFeatureNavigation } from "@renderer/components/workbench/feature-navigation";
import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { TodoTasks } from "./todo-tasks";

function todoDetails(message: ToolResultSessionMessage): TodoDetails | null {
	if (message.toolName !== "todo" || !isTodoOrigin(message.toolOrigin ?? null)) return null;
	const parsed = todoDetailsSchema.safeParse(message.details);
	return parsed.success ? parsed.data : null;
}

/** Shows rpiv-todo results as a checklist and keeps Pi's own rendering one click away. */
export function TodoToolResult({ message, children }: { message: ToolResultSessionMessage; children: ReactNode }) {
	const details = useMemo(() => todoDetails(message), [message]);
	return details ? <TodoChecklist details={details}>{children}</TodoChecklist> : children;
}

function TodoChecklist({ details, children }: { details: TodoDetails; children: ReactNode }) {
	const { t } = useTranslation();
	const openFeature = useFeatureNavigation();
	const [originalOpen, setOriginalOpen] = useState(false);
	return (
		<div className="flex min-w-0 flex-col gap-2 rounded-control border border-border-subtle bg-surface px-3 py-2.5">
			<TodoTasks
				value={details}
				compact
				more={
					<Button variant="ghost" size="sm" className="mt-2 self-start" onClick={() => openFeature("todo")}>
						{t("todo.viewAll")}
					</Button>
				}
			/>
			<details
				className="min-w-0 border-t border-border-subtle pt-2 text-xs text-text-muted"
				onToggle={(event) => setOriginalOpen(event.currentTarget.open)}
			>
				<summary className="w-fit cursor-default rounded-sm focus-visible:bg-surface-hover">
					{t("todo.originalResult")}
				</summary>
				{originalOpen && <div className="mt-2 flex min-w-0 flex-col gap-2">{children}</div>}
			</details>
		</div>
	);
}
