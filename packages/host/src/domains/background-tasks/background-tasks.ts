import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
	activeJobStatuses,
	backgroundJobsSchema,
	type BackgroundJob,
	type BackgroundOutput,
} from "@ling/contracts/background-tasks";
import { sessionKey, type SessionRef } from "@ling/contracts/session-ref";
import { toError } from "@ling/core/ling-error";
import { createLogger } from "@ling/core/logger";
import { z } from "zod";
import { createFeatureStore, featureDataPath } from "../companions/feature-store";
import { toolResult, type CompanionToolHandlers } from "../companions/tool-dispatch";
import { createBackgroundProcesses, readOutputWindow } from "./processes";

const log = createLogger("background-tasks");
const logSchema = z.object({ base: z.number().int().nonnegative(), text: z.string() });

/** Shell commands the agent or the user runs beside a session, with bounded output kept after exit. */
export function createBackgroundTasks(options: {
	home: string;
	requireEnabled(): Promise<void>;
	assertProject(cwd: string): Promise<void>;
	assertSession(ref: SessionRef): void;
	notify(ref: SessionRef, attention: boolean, title: string, body: string): void;
	onChanged(ref: SessionRef | null): void;
}) {
	const store = createFeatureStore({
		home: options.home,
		directory: "ling-background-tasks",
		key: "jobs",
		schema: backgroundJobsSchema,
		initial: () => [],
	});
	const processes = createBackgroundProcesses((ref) => options.onChanged(ref));
	const loops = new Set<Promise<void>>();
	const failures = new Map<string, string>();
	const logs = featureDataPath(options.home, "ling-background-tasks", "output");
	const lifetime = new AbortController();
	const path = (id: string) => join(logs, `${z.uuid().parse(id)}.log`);
	async function publishLog(id: string, base: number, text: string) {
		const temporary = `${path(id)}.tmp`;
		await writeFile(temporary, JSON.stringify({ base, text }), { mode: 0o600 });
		await rename(temporary, path(id));
	}
	async function keep(job: BackgroundJob) {
		const removed: string[] = [];
		await store.update((items) => {
			const next = items.filter((item) => item.id !== job.id).concat(job);
			while (next.length > 100) {
				const index = next.findIndex((item) => !activeJobStatuses.has(item.status));
				if (index < 0) throw new Error("Background history capacity exhausted");
				removed.push(next[index]!.id);
				next.splice(index, 1);
			}
			return next;
		});
		for (const id of removed) {
			failures.delete(id);
			await rm(path(id), { force: true });
		}
		options.onChanged(job.ref);
	}
	/** Mirrors the retained output to disk while the process runs, then persists its settled state. */
	async function collect(job: BackgroundJob) {
		let published = 0;
		try {
			while (!lifetime.signal.aborted) {
				const output = processes.retained(job.id);
				if (output.end !== published) {
					await publishLog(job.id, output.base, output.text);
					published = output.end;
				}
				// Output is complete once the process has closed.
				if (!activeJobStatuses.has(output.process.status)) {
					const settled = await processes.wait(job.id);
					await keep(settled);
					processes.forget(job.id);
					options.notify(
						job.ref,
						settled.status === "failed",
						"Background task finished",
						`${settled.status}: ${job.command}`,
					);
					return;
				}
				await delay(300, undefined, { signal: lifetime.signal }).catch(() => undefined);
			}
		} catch (error) {
			failures.set(job.id, toError(error).message);
			if (!lifetime.signal.aborted) options.onChanged(job.ref);
		}
	}
	async function start(ref: SessionRef, command: string, timeoutMs?: number): Promise<BackgroundJob> {
		await options.assertProject(ref.cwd);
		options.assertSession(ref);
		await options.requireEnabled();
		const job = await processes.start(ref, command, timeoutMs);
		try {
			await publishLog(job.id, 0, "");
			await keep(job);
		} catch (error) {
			await processes.stop(job.id);
			processes.forget(job.id);
			throw error;
		}
		const loop = collect(job);
		loops.add(loop);
		void loop
			.finally(() => loops.delete(loop))
			.catch((error: unknown) => log.error("output collection failed:", error));
		return job;
	}
	async function list(ref: SessionRef): Promise<BackgroundJob[]> {
		const live = processes.list(ref);
		return (await store.read())
			.filter((stored) => sessionKey(stored.ref) === sessionKey(ref))
			.map((stored) => {
				const job = { ...stored, ...live.find((item) => item.id === stored.id) };
				return { ...job, error: failures.get(job.id) ?? job.error };
			});
	}
	const isLive = (ref: SessionRef, id: string) => processes.list(ref).some((item) => item.id === id);
	async function read(ref: SessionRef, id: string, offset: number): Promise<BackgroundOutput> {
		const job = (await list(ref)).find((item) => item.id === id);
		if (!job) throw new Error("Task does not belong to this session");
		if (isLive(ref, id)) return processes.read(id, offset);
		const file = await open(path(id), "r");
		let stored: z.infer<typeof logSchema>;
		try {
			// JSON escaping can expand a bounded output tail, but edited files are still bounded.
			if ((await file.stat()).size > 16 * 1_048_576) throw new Error("Retained process log exceeds its size limit");
			stored = logSchema.parse(JSON.parse(await file.readFile("utf8")) as unknown);
		} finally {
			await file.close();
		}
		return { process: job, ...readOutputWindow(Buffer.from(stored.text), stored.base, offset) };
	}
	async function stop(ref: SessionRef, id: string) {
		const job = (await list(ref)).find((item) => item.id === id);
		if (!job) throw new Error("Task does not belong to this session");
		if (!isLive(ref, id)) return job;
		const stopped = await processes.stop(id);
		await keep(stopped);
		return stopped;
	}
	const tools = {
		background_start: async (ref, { command, timeoutMs }) => toolResult(await start(ref, command, timeoutMs)),
		background_list: async (ref) => toolResult(await list(ref)),
		background_read: async (ref, { id, offset }) => toolResult(await read(ref, id, offset)),
		background_stop: async (ref, { id }) => toolResult(await stop(ref, id)),
	} satisfies Pick<
		CompanionToolHandlers,
		"background_start" | "background_list" | "background_read" | "background_stop"
	>;
	return {
		tools,
		list,
		start,
		read,
		stop,
		/** Runs left over from an earlier Host generation are recorded as interrupted, never restarted. */
		async initialize() {
			await mkdir(logs, { recursive: true });
			await store.update((items) =>
				items.map((job) =>
					activeJobStatuses.has(job.status)
						? {
								...job,
								status: "interrupted",
								error: "Ling restarted; this task was not restarted",
								finishedAt: Date.now(),
							}
						: job,
				),
			);
		},
		async dispose() {
			lifetime.abort();
			await processes.release();
			await Promise.all(loops);
		},
	};
}
export type BackgroundTasks = ReturnType<typeof createBackgroundTasks>;
