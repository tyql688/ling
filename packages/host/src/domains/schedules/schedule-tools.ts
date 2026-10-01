import type { UiLanguage } from "@ling/contracts/application";
import {
	describeSchedule,
	scheduleTaskInputSchema,
	type SchedulesSnapshot,
	type ScheduleTask,
	type ScheduleTaskInput,
} from "@ling/contracts/schedules";
import type { SessionRef } from "@ling/contracts/session-ref";
import { hostWords } from "../companions/host-words";
import { toolResult, type CompanionToolHandlers } from "../companions/tool-dispatch";
import type { Interactions } from "../interactions/interactions";

const SCHEDULE_WORDS = {
	once: "Once",
	everyMinutes: "Every {{count}} minutes",
	everyDay: "Every day",
	weekdays: "Weekdays",
} as const;
/** Keep agent queries bounded independently of the retained execution history. */
const RECENT_OUTCOMES = 20;

export function createScheduleTools(options: {
	read(): Promise<SchedulesSnapshot>;
	save(
		id: string | null,
		revision: number | null,
		task: ScheduleTaskInput,
		status?: "active" | "paused",
	): Promise<{ tasks: ScheduleTask[] }>;
	setStatus(id: string, status: "active" | "paused", revision: number): Promise<SchedulesSnapshot>;
	remove(id: string, revision: number): Promise<SchedulesSnapshot>;
	requireEnabled(): Promise<void>;
	interactions: Pick<Interactions, "request">;
}) {
	async function readTask(id: string, revision?: number) {
		const current = await options.read();
		const task = current.tasks.find((item) => item.id === id);
		if (!task) throw new Error("Schedule no longer exists");
		if (revision !== undefined && task.revision !== revision)
			throw new Error("Schedule changed; read it again before editing");
		return {
			task,
			history: current.history.filter((item) => item.taskId === id).slice(-RECENT_OUTCOMES),
			error: current.error,
		};
	}
	async function confirm(
		ref: SessionRef,
		action: "create" | "update" | "delete",
		task: ScheduleTaskInput,
		language: UiLanguage | undefined,
		signal: AbortSignal,
		status?: ScheduleTask["status"],
	) {
		const w = hostWords(language);
		const title =
			action === "create"
				? "Confirm schedule"
				: action === "update"
					? "Confirm schedule update"
					: "Confirm schedule deletion";
		const answer = await options.interactions.request(
			"schedules",
			{
				ref,
				kind: "approval",
				title: `${w(title)}: ${task.title}`,
				body: [
					...(action === "delete"
						? [w("This deletes the task and its run history. Conversation records are kept.")]
						: []),
					`**${w("Instructions")}**\n\n${task.prompt}`,
					...(status ? [`**${w("Schedule status")}**: ${w(status)}`] : []),
					`**${w("Repeat")}**: ${describeSchedule(task.schedule, language, (key, count) => w(SCHEDULE_WORDS[key], { count: count ?? "" }))}`,
					...(task.schedule.kind === "calendar" ? [`**${w("Time zone")}**: ${task.schedule.timeZone}`] : []),
					`**${w("Project")}**: ${task.cwd}`,
					`**${w("Run in")}**: ${w(task.sessionId ? "This conversation" : "New conversation each time")}`,
					`**${w("Model")}**: ${task.model ? `${task.model.provider} / ${task.model.id}` : w("Follow project model")}`,
					`**${w("Reasoning")}**: ${task.thinking ? w(task.thinking) : w("Follow settings")}`,
					`**${w("Missed runs")}**: ${w(task.missed === "skip" ? "Skip missed runs" : "Run latest once on return")}`,
					`**${w("Notifications")}**: ${w(task.notifications === "all" ? "All runs" : task.notifications === "attention" ? "Needs attention" : "None")}`,
				].join("\n\n"),
			},
			signal,
		);
		signal.throwIfAborted();
		return answer.status === "answered" && answer.approved === true;
	}
	return {
		schedule_list: async () => {
			const current = await options.read();
			return toolResult({
				tasks: current.tasks.map(({ prompt, ...task }) => ({
					...task,
					prompt: prompt.slice(0, 1000),
					promptTruncated: prompt.length > 1000,
				})),
				history: current.history.slice(-RECENT_OUTCOMES),
				error: current.error,
			});
		},
		schedule_get: async (_ref, { id }) => toolResult(await readTask(id)),
		schedule_create: async (ref, { language, ...task }, signal) => {
			await options.requireEnabled();
			if (!(await confirm(ref, "create", task, language, signal))) return toolResult({ status: "cancelled" });
			const saved = await options.save(null, null, task);
			return toolResult({ status: "created", task: saved.tasks.at(-1)! });
		},
		schedule_update: async (ref, { id, expectedRevision, changes, language }, signal) => {
			await options.requireEnabled();
			const { task } = await readTask(id, expectedRevision);
			const { status, ...fields } = changes;
			const next = scheduleTaskInputSchema.parse({ ...task, ...fields });
			const editing = Object.keys(fields).length > 0;
			const nextStatus = status ?? (task.status === "paused" ? "paused" : "active");
			if (!(await confirm(ref, "update", next, language, signal, nextStatus)))
				return toolResult({ status: "cancelled" });
			const saved = editing
				? await options.save(id, expectedRevision, next, nextStatus)
				: await options.setStatus(id, nextStatus, expectedRevision);
			return toolResult({ status: "updated", task: saved.tasks.find((item) => item.id === id)! });
		},
		schedule_delete: async (ref, { id, expectedRevision, language }, signal) => {
			const { task } = await readTask(id, expectedRevision);
			if (!(await confirm(ref, "delete", task, language, signal, task.status)))
				return toolResult({ status: "cancelled" });
			await options.remove(id, expectedRevision);
			return toolResult({ status: "deleted", id });
		},
	} satisfies Pick<
		CompanionToolHandlers,
		"schedule_list" | "schedule_get" | "schedule_create" | "schedule_update" | "schedule_delete"
	>;
}
