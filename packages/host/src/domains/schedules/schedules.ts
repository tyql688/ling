import { randomUUID } from "node:crypto";
import {
	describeSchedule,
	schedulesStateSchema,
	type ScheduleModel,
	type ScheduleOccurrence,
	type SchedulesSnapshot,
	type ScheduleTask,
	type ScheduleTaskInput,
} from "@ling/contracts/schedules";
import type { SessionRef } from "@ling/contracts/session-ref";
import { toError } from "@ling/core/ling-error";
import { createLogger } from "@ling/core/logger";
import type { CompanionRuns } from "../companions/companion-runs";
import { createFeatureStore } from "../companions/feature-store";
import { hostWords } from "../companions/host-words";
import { toolResult, type CompanionToolHandlers } from "../companions/tool-dispatch";
import type { Interactions } from "../interactions/interactions";
import { appendOccurrence, nextOccurrence } from "./calendar";
import type { BuiltinFeatureStore } from "../companions/builtin-features";

const log = createLogger("schedules");
const failure = (value: unknown) => toError(value).message;
/** Scheduled work shares two execution lanes; a backlog must not launch an unbounded model burst. */
const MAX_CONCURRENT_RUNS = 2;
/** One minute of timer or suspend jitter is not a missed historical run. */
const MISSED_GRACE_MS = 60_000;

const SCHEDULE_WORDS = {
	once: "Once",
	everyMinutes: "Every {{count}} minutes",
	everyDay: "Every day",
	weekdays: "Weekdays",
} as const;

interface RunHandle {
	controller: AbortController;
	runId: string | null;
	done: Promise<void>;
}

/** Recurring agent runs: a durable task list, a one-second tick and bounded run history. */
export function createSchedules(options: {
	home: string;
	features: Pick<BuiltinFeatureStore, "read" | "requireEnabled">;
	runs: Pick<CompanionRuns, "start" | "wait" | "cancel">;
	interactions: Interactions;
	listModels(cwd: string): Promise<ScheduleModel[]>;
	notify(ref: SessionRef, attention: boolean, title: string, body: string): void;
	onChanged(): void;
}) {
	const store = createFeatureStore({
		home: options.home,
		directory: "ling-schedules",
		key: "schedules",
		schema: schedulesStateSchema,
		initial: () => ({ tasks: [], history: [] }),
	});
	const owned = new Map<string, RunHandle>();
	const lifetime = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	/** The latest tick failure; cleared by the next tick that succeeds. */
	let error: string | null = null;
	const update: typeof store.update = async (mutate) => {
		const value = await store.update(mutate);
		options.onChanged();
		return value;
	};
	const snapshot = async (value?: Awaited<ReturnType<typeof store.read>>): Promise<SchedulesSnapshot> => ({
		...(value ?? (await store.read())),
		error,
	});
	function cancelPending(id: string) {
		const handle = owned.get(id);
		if (handle && handle.runId === null) handle.controller.abort();
	}
	async function save(id: string | null, expectedRevision: number | null, task: ScheduleTaskInput) {
		await options.features.requireEnabled("schedules");
		const now = Date.now();
		const nextAt = nextOccurrence(task.schedule, now);
		if (nextAt === null) throw new Error("Choose a future time");
		const saved = await update((value) => {
			const previous = id ? value.tasks.find((item) => item.id === id) : null;
			if (id && (!previous || previous.revision !== expectedRevision))
				throw new Error("This schedule changed; refresh before saving");
			const next: ScheduleTask = {
				...task,
				id: id ?? randomUUID(),
				revision: (previous?.revision ?? 0) + 1,
				status: previous?.status === "paused" ? "paused" : "active",
				nextAt,
				updatedAt: now,
			};
			return {
				...value,
				tasks: previous ? value.tasks.map((item) => (item.id === id ? next : item)) : [...value.tasks, next],
			};
		});
		if (id) cancelPending(id);
		return saved;
	}
	/** Records the occurrence before the run starts, so a failure to prepare reaches the caller. */
	async function dispatch(task: ScheduleTask, scheduledAt: number, manual = false) {
		await options.features.requireEnabled("schedules");
		if (owned.has(task.id)) throw new Error("This task already has an active run");
		if (owned.size >= MAX_CONCURRENT_RUNS)
			throw new Error("Two scheduled tasks are running; wait for a lane to finish");
		const handle: RunHandle = { controller: new AbortController(), runId: null, done: Promise.resolve() };
		owned.set(task.id, handle);
		const occurrenceId = randomUUID();
		try {
			await update((value) => {
				const current = value.tasks.find((item) => item.id === task.id);
				if (!current || current.revision !== task.revision || (!manual && current.status !== "active"))
					throw new Error("Schedule changed before dispatch");
				const nextAt = manual ? current.nextAt : nextOccurrence(current.schedule, Date.now());
				return {
					tasks: value.tasks.map((item) =>
						item.id === task.id
							? { ...item, nextAt, status: nextAt === null && !manual ? "completed" : item.status }
							: item,
					),
					history: appendOccurrence(value.history, {
						id: occurrenceId,
						taskId: task.id,
						taskRevision: task.revision,
						scheduledAt,
						startedAt: Date.now(),
						finishedAt: null,
						runId: null,
						sessionId: task.sessionId,
						cwd: task.cwd,
						status: "prepared",
						error: null,
						summary: "",
						unread: false,
					}),
				};
			});
		} catch (cause) {
			owned.delete(task.id);
			throw cause;
		}
		handle.done = execute(task, occurrenceId, handle)
			.catch((cause: unknown) => log.error("scheduled occurrence could not be recorded:", cause))
			.finally(() => owned.delete(task.id));
		return { occurrenceId };
	}
	async function execute(task: ScheduleTask, occurrenceId: string, handle: RunHandle) {
		const { signal } = handle.controller;
		const finish = (status: ScheduleOccurrence["status"], error: string | null, summary = "") =>
			update((value) => ({
				...value,
				history: value.history.map((entry) =>
					entry.id === occurrenceId
						? { ...entry, status, error, summary, finishedAt: Date.now(), unread: true }
						: entry,
				),
			}));
		try {
			signal.throwIfAborted();
			const start = await options.runs.start(
				{
					cwd: task.cwd,
					...(task.sessionId ? { sessionId: task.sessionId } : {}),
					requestId: occurrenceId,
					title: task.title,
					prompt: task.prompt,
					...(task.model ? { model: task.model } : {}),
					...(task.thinking ? { thinking: task.thinking } : {}),
				},
				signal,
			);
			if (start.status === "busy") {
				await finish("skipped", "The target session has a user turn or queued work");
				return;
			}
			handle.runId = start.run.runId;
			await update((value) => ({
				...value,
				history: value.history.map((entry) =>
					entry.id === occurrenceId
						? { ...entry, status: "running", runId: start.run.runId, sessionId: start.run.ref.sessionId }
						: entry,
				),
			}));
			if (signal.aborted) await options.runs.cancel(start.run.runId);
			const run = await options.runs.wait(start.run.runId);
			await finish(run.status === "running" ? "interrupted" : run.status, run.error, run.text.slice(-512));
			if (task.notifications === "all" || (task.notifications === "attention" && run.status !== "completed"))
				options.notify(run.ref, run.status !== "completed", task.title, run.error ?? run.text.slice(0, 500));
		} catch (cause) {
			if (lifetime.signal.aborted) return;
			const failures = [failure(cause)];
			if (handle.runId) {
				try {
					await options.runs.cancel(handle.runId);
					await options.runs.wait(handle.runId);
				} catch (cleanupError) {
					failures.push(failure(cleanupError));
				}
			}
			await finish(signal.aborted ? "cancelled" : "interrupted", failures.join("\n"));
		}
	}
	async function tick() {
		let failed: string | null = null;
		try {
			const features = await options.features.read();
			if (!features.enabled.schedules) return;
			const now = Date.now();
			for (const task of (await store.read()).tasks) {
				if (lifetime.signal.aborted || owned.size >= MAX_CONCURRENT_RUNS) break;
				if (task.status !== "active" || task.nextAt === null || task.nextAt > now || owned.has(task.id)) continue;
				const disabledOccurrence = features.schedulesResumedAt !== null && task.nextAt <= features.schedulesResumedAt;
				if (disabledOccurrence || (now - task.nextAt > MISSED_GRACE_MS && task.missed === "skip")) {
					await update((value) => ({
						...value,
						history: value.tasks.some((entry) => entry.id === task.id && entry.revision === task.revision)
							? appendOccurrence(value.history, {
									id: randomUUID(),
									taskId: task.id,
									taskRevision: task.revision,
									scheduledAt: task.nextAt!,
									startedAt: now,
									finishedAt: now,
									runId: null,
									sessionId: task.sessionId,
									cwd: task.cwd,
									status: "skipped",
									error: null,
									summary: disabledOccurrence
										? "Occurrence skipped while scheduled tasks were disabled"
										: "Missed occurrence skipped by the task's configured policy",
									unread: true,
								})
							: value.history,
						tasks: value.tasks.map((entry) => {
							if (entry.id !== task.id || entry.revision !== task.revision) return entry;
							const nextAt = nextOccurrence(entry.schedule, now);
							return { ...entry, nextAt, status: nextAt === null ? "completed" : entry.status };
						}),
					}));
					continue;
				}
				await dispatch(task, task.nextAt);
			}
		} catch (cause) {
			failed = failure(cause);
		} finally {
			if (failed !== error) {
				error = failed;
				options.onChanged();
			}
			if (!lifetime.signal.aborted) timer = setTimeout(() => void tick(), 1_000);
		}
	}
	const tools = {
		schedule_list: async () => {
			const current = await store.read();
			return toolResult({
				tasks: current.tasks.map(({ prompt, ...task }) => ({ ...task, prompt: prompt.slice(0, 1000) })),
				history: current.history.slice(-20),
			});
		},
		schedule_create: async (ref, { language, ...task }, signal) => {
			await options.features.requireEnabled("schedules");
			const w = hostWords(language);
			const answer = await options.interactions.request(
				"schedules",
				{
					ref,
					kind: "approval",
					title: `${w("Confirm schedule")}: ${task.title}`,
					body: [
						`**${w("Instructions")}**\n\n${task.prompt}`,
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
			if (!answer.approved) return toolResult({ status: "cancelled" });
			const saved = await save(null, null, task);
			return toolResult({ status: "created", task: saved.tasks.at(-1)! });
		},
	} satisfies Pick<CompanionToolHandlers, "schedule_list" | "schedule_create">;
	return {
		tools,
		snapshot: () => snapshot(),
		models: options.listModels,
		save: async (id: string | null, expectedRevision: number | null, task: ScheduleTaskInput) =>
			snapshot(await save(id, expectedRevision, task)),
		async setStatus(id: string, status: "active" | "paused", revision: number) {
			if (status === "active") await options.features.requireEnabled("schedules");
			const saved = await update((value) => {
				const task = value.tasks.find((item) => item.id === id);
				if (!task || task.revision !== revision) throw new Error("Schedule changed; refresh before saving");
				const nextAt = status === "active" ? nextOccurrence(task.schedule, Date.now()) : task.nextAt;
				if (status === "active" && nextAt === null) throw new Error("Edit the task to choose a future time");
				return {
					...value,
					tasks: value.tasks.map((item) =>
						item.id === id ? { ...item, revision: item.revision + 1, status, nextAt } : item,
					),
				};
			});
			cancelPending(id);
			return snapshot(saved);
		},
		async run(id: string) {
			const task = (await store.read()).tasks.find((item) => item.id === id);
			if (!task) throw new Error("Schedule no longer exists");
			return dispatch(task, Date.now(), true);
		},
		async stop(id: string) {
			const handle = owned.get(id);
			if (!handle) throw new Error("This task has no active run");
			handle.controller.abort();
			if (handle.runId) await options.runs.cancel(handle.runId);
			await handle.done;
		},
		async delete(id: string, revision: number) {
			if (owned.has(id)) throw new Error("Stop the active run before deleting this task");
			return snapshot(
				await update((value) => {
					const task = value.tasks.find((item) => item.id === id);
					if (!task || task.revision !== revision) throw new Error("Schedule changed");
					return {
						tasks: value.tasks.filter((item) => item.id !== id),
						history: value.history.filter((item) => item.taskId !== id),
					};
				}),
			);
		},
		async markRead(id: string | null) {
			return snapshot(
				await update((value) => ({
					...value,
					history: value.history.map((entry) => (id === null || entry.id === id ? { ...entry, unread: false } : entry)),
				})),
			);
		},
		/** Closes occurrences an earlier Host generation left running, then starts the tick. */
		async initialize() {
			try {
				await update((value) => ({
					...value,
					history: value.history.map((entry) =>
						entry.status === "prepared" || entry.status === "running"
							? {
									...entry,
									status: "interrupted",
									finishedAt: Date.now(),
									error: "Ling restarted; this occurrence was not replayed",
									unread: true,
								}
							: entry,
					),
				}));
			} finally {
				timer = setTimeout(() => void tick(), 1_000);
			}
		},
		async dispose() {
			lifetime.abort();
			clearTimeout(timer);
			for (const handle of owned.values()) handle.controller.abort();
			await Promise.allSettled([...owned.values()].map((handle) => handle.done));
		},
	};
}
export type Schedules = ReturnType<typeof createSchedules>;
