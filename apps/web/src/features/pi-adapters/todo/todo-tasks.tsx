import type { TodoDetails } from "@ling/contracts/todo";
import { Button } from "@renderer/components/ui/button";
import { FeedbackNotice } from "@renderer/components/ui/feedback";
import { cn } from "@renderer/lib/utils";
import { Check, ListTodo, Play, Square } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

const filters = ["all", "open", "completed"] as const;

/** Read-only checklist projection; the agent's todo tool owns every change. */
export function TodoTasks({
	value,
	compact = false,
	more,
}: {
	value: TodoDetails;
	compact?: boolean;
	more?: ReactNode;
}) {
	const { t } = useTranslation();
	const [filter, setFilter] = useState<(typeof filters)[number]>("all");
	const [limit, setLimit] = useState(compact ? 6 : 40);
	const tasks = value.tasks.filter((task) => task.status !== "deleted");
	const visible = tasks.filter(
		(task) => filter === "all" || (filter === "completed" ? task.status === "completed" : task.status !== "completed"),
	);
	const completed = tasks.filter((task) => task.status === "completed").length;
	return (
		<div className="flex min-w-0 flex-col">
			<div className="flex items-center gap-2 pb-2.5 font-medium">
				<ListTodo className="size-4" aria-hidden="true" />
				<span>{t("todo.title")}</span>
				<span className="ml-auto text-xs tabular-nums text-text-muted">
					{completed} / {tasks.length}
				</span>
			</div>
			<div
				role="progressbar"
				aria-label={t("todo.progress")}
				aria-valuemin={0}
				aria-valuemax={tasks.length}
				aria-valuenow={completed}
				className="mb-2.5 h-[3px] overflow-hidden rounded-control bg-surface-hover"
			>
				<div
					className="h-full bg-text-secondary"
					style={{ width: `${tasks.length ? (100 * completed) / tasks.length : 0}%` }}
				/>
			</div>
			{!compact && (
				<div className="mb-2 flex gap-1">
					{filters.map((key) => (
						<Button
							key={key}
							variant="ghost"
							size="sm"
							aria-pressed={filter === key}
							className={cn(filter === key && "bg-surface-hover text-text-primary")}
							onClick={() => setFilter(key)}
						>
							{t(`todo.filter.${key}`)}
						</Button>
					))}
				</div>
			)}
			{value.error && (
				<FeedbackNotice tone="danger" className="text-xs">
					{value.error}
				</FeedbackNotice>
			)}
			{visible.slice(0, limit).map((task) => (
				<div key={task.id} className="flex items-start gap-2.5 border-b border-border-subtle py-3">
					<span className="mt-[3px] shrink-0 text-text-muted" aria-hidden="true">
						{task.status === "completed" ? (
							<Check className="size-[15px]" />
						) : task.status === "in_progress" ? (
							<Play className="size-[15px]" />
						) : (
							<Square className="size-[15px]" />
						)}
					</span>
					<span className="sr-only">{t(`todo.status.${task.status}`)}</span>
					<div className="flex min-w-0 flex-1 flex-col gap-1 [overflow-wrap:anywhere]">
						<span
							className={cn(
								task.status === "completed" && "text-text-muted",
								task.status === "in_progress" && "font-medium",
							)}
						>
							{task.subject}
						</span>
						{task.status === "in_progress" && task.activeForm && task.activeForm !== task.subject && (
							<span className="text-xs text-text-muted">{task.activeForm}</span>
						)}
						{!!task.blockedBy?.length && (
							<span className="text-xs text-text-muted">
								{t("todo.dependsOn")}{" "}
								{task.blockedBy.map((id) => tasks.find((entry) => entry.id === id)?.subject ?? `#${id}`).join(" · ")}
							</span>
						)}
						{!compact && (task.description || task.owner || task.metadata) && (
							<details className="text-xs text-text-muted">
								<summary className="cursor-default">{t("todo.details")}</summary>
								<div className="mt-1 flex flex-col gap-1 whitespace-pre-wrap">
									{task.description && <span>{task.description}</span>}
									{task.owner && (
										<span>
											{t("todo.owner")}: {task.owner}
										</span>
									)}
									{task.metadata && <span className="font-mono">{JSON.stringify(task.metadata, null, 2)}</span>}
								</div>
							</details>
						)}
					</div>
					<span className="shrink-0 text-xs tabular-nums text-text-muted">#{task.id}</span>
				</div>
			))}
			{visible.length > limit &&
				(compact ? (
					more
				) : (
					<Button variant="ghost" size="sm" className="mt-2 self-start" onClick={() => setLimit(limit + 40)}>
						{t("todo.showMore")}
					</Button>
				))}
			{visible.length === 0 && (
				<p className="py-3 text-xs text-text-muted">{t(tasks.length ? "todo.noneInView" : "todo.empty")}</p>
			)}
		</div>
	);
}
