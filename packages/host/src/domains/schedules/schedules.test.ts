import { rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import type { CompanionRun, CompanionRunAdmission } from "@ling/contracts/companions";
import { createInteractions } from "../interactions/interactions";
import { createSchedules } from "./schedules";
import { createBuiltinFeatures } from "../companions/builtin-features";
import { companionTools } from "@ling/contracts/companion-tools";
import { temporaryDirectory } from "../../../../../test/temporary-directory";

async function harness(options: { pending?: boolean; missed?: "skip" | "latest" } = {}) {
	const home = await temporaryDirectory("schedules");
	const features = createBuiltinFeatures(home);
	const cancelled = vi.fn();
	const ref = { cwd: "/example", sessionId: "session" };
	const interactions = createInteractions(() => undefined);
	const run = (status: CompanionRun["status"], text = ""): CompanionRun => ({
		runId: "owned-run",
		ref,
		status,
		error: null,
		tokens: 0,
		text,
	});
	const schedules = createSchedules({
		features,
		home,
		interactions,
		listModels: async () => [],
		notify: () => undefined,
		onChanged: () => undefined,
		runs: {
			start(_input, signal): Promise<CompanionRunAdmission> {
				if (options.pending)
					return new Promise((_resolve, reject) => {
						signal.addEventListener("abort", () => reject(new Error("admission cancelled")), { once: true });
					});
				return Promise.resolve({ status: "started", run: run("running") });
			},
			wait: async () => run("completed", "MODEL_OK"),
			cancel: async (runId) => {
				cancelled(runId);
				return run("cancelled");
			},
		},
	});
	await schedules.initialize();
	await schedules.save(null, null, {
		title: "test",
		prompt: "test",
		cwd: "/example",
		sessionId: null,
		schedule: { kind: "once", at: Date.now() + 60_000 },
		model: null,
		thinking: null,
		missed: options.missed ?? "skip",
		notifications: "all",
	});
	return {
		features,
		schedules,
		cancelled,
		ref,
		interactions,
		async answer(approved: boolean, status: "answered" | "skipped" = "answered") {
			await vi.waitFor(() => expect(interactions.list()).toHaveLength(1));
			const request = interactions.list()[0]!;
			interactions.answer(request.id, request.id, { status, approved, answers: [] });
		},
		read: () => schedules.snapshot(),
		async close() {
			interactions.dispose();
			await schedules.dispose();
			await rm(home, { recursive: true, force: true });
		},
	};
}

describe("scheduled occurrences", () => {
	it("disabling suspends dispatch and re-enabling skips disabled occurrences even with catch-up enabled", async () => {
		const host = await harness({ missed: "latest" });
		const clock = vi.spyOn(Date, "now");
		try {
			const task = (await host.read()).tasks[0]!;
			await host.features.write({ id: "schedules", enabled: false, expectedRevision: 0 }, new AbortController().signal);
			clock.mockReturnValue(task.nextAt! + 1_000);
			await expect(host.schedules.run(task.id)).rejects.toMatchObject({
				lingError: { code: "BUILTIN_FEATURE_DISABLED" },
			});
			await delay(1_100);
			expect((await host.read()).history).toEqual([]);
			await host.features.write({ id: "schedules", enabled: true, expectedRevision: 1 }, new AbortController().signal);
			await vi.waitFor(async () => expect((await host.read()).history[0]?.status).toBe("skipped"), { timeout: 2_000 });
			expect((await host.read()).tasks[0]?.status).toBe("completed");
		} finally {
			clock.mockRestore();
			await host.close();
		}
	});

	it("pausing cancels an admission still waiting to start", async () => {
		const host = await harness({ pending: true });
		try {
			const task = (await host.read()).tasks[0]!;
			await host.schedules.run(task.id);
			await vi.waitFor(async () => expect((await host.read()).history[0]?.status).toBe("prepared"));
			await host.schedules.setStatus(task.id, "paused", task.revision);
			await vi.waitFor(async () => expect((await host.read()).history[0]?.status).toBe("cancelled"));
			expect((await host.read()).tasks[0]?.status).toBe("paused");
			expect(host.cancelled).not.toHaveBeenCalled();
		} finally {
			await host.close();
		}
	});
});

describe("schedule agent tools", () => {
	it("creates, reads, patches, pauses and deletes through the shared task store", async () => {
		const host = await harness();
		const signal = new AbortController().signal;
		try {
			const original = (await host.read()).tasks[0]!;
			const prompt = "Complete instructions. ".repeat(100).trim();
			const creating = host.schedules.tools.schedule_create(
				host.ref,
				companionTools.schedule_create.input.parse({
					...original,
					title: "Daily task",
					prompt,
					model: { provider: "fixture", id: "model" },
					thinking: "high",
					schedule: { kind: "calendar", time: "09:00", timeZone: "Asia/Shanghai", days: [1, 2, 3, 4, 5] },
				}),
				signal,
			);
			await host.answer(true);
			expect((await creating).details).toMatchObject({ status: "created" });
			const created = (await host.read()).tasks.at(-1)!;
			expect((await host.schedules.tools.schedule_list()).details).toMatchObject({
				tasks: [expect.anything(), { id: created.id, prompt: prompt.slice(0, 1000), promptTruncated: true }],
			});
			expect((await host.schedules.tools.schedule_get(host.ref, { id: created.id })).details).toMatchObject({
				task: { prompt, revision: 1 },
				history: [],
			});
			const updating = host.schedules.tools.schedule_update(
				host.ref,
				{
					id: created.id,
					expectedRevision: created.revision,
					changes: { title: "Edited task", model: null, status: "paused" },
				},
				signal,
			);
			await host.answer(true);
			expect((await updating).details).toMatchObject({
				status: "updated",
				task: {
					title: "Edited task",
					model: null,
					status: "paused",
					revision: 2,
					prompt,
					thinking: "high",
					schedule: created.schedule,
				},
			});
			const resumed = host.schedules.tools.schedule_update(
				host.ref,
				{ id: created.id, expectedRevision: 2, changes: { status: "active" } },
				signal,
			);
			await host.answer(true);
			expect((await resumed).details).toMatchObject({ task: { status: "active", revision: 3 } });
			await host.schedules.run(created.id);
			await vi.waitFor(async () => expect((await host.read()).history[0]?.status).toBe("completed"));
			const deleting = host.schedules.tools.schedule_delete(host.ref, { id: created.id, expectedRevision: 3 }, signal);
			await host.answer(true);
			expect((await deleting).details).toEqual({ status: "deleted", id: created.id });
			expect((await host.read()).tasks).toEqual([original]);
			expect((await host.read()).history).toEqual([]);
			await expect(host.schedules.tools.schedule_get(host.ref, { id: created.id })).rejects.toThrow("no longer exists");
		} finally {
			await host.close();
		}
	});

	it.each(["update", "delete"] as const)("rejects a stale %s after the user confirms", async (action) => {
		const host = await harness();
		const signal = new AbortController().signal;
		try {
			const task = (await host.read()).tasks[0]!;
			const input = { id: task.id, expectedRevision: task.revision };
			const request =
				action === "update"
					? host.schedules.tools.schedule_update(host.ref, { ...input, changes: { title: "Agent edit" } }, signal)
					: host.schedules.tools.schedule_delete(host.ref, input, signal);
			await vi.waitFor(() => expect(host.interactions.list()).toHaveLength(1));
			await host.schedules.save(task.id, task.revision, { ...task, prompt: "Concurrent user edit" });
			await host.answer(true);
			await expect(request).rejects.toThrow("changed");
			expect((await host.read()).tasks[0]).toMatchObject({
				title: task.title,
				prompt: "Concurrent user edit",
				revision: 2,
			});
		} finally {
			await host.close();
		}
	});

	it("keeps rejected, skipped and interrupted requests from changing tasks", async () => {
		const host = await harness();
		try {
			const task = (await host.read()).tasks[0]!;
			for (const status of ["answered", "skipped"] as const) {
				const request = host.schedules.tools.schedule_update(
					host.ref,
					{ id: task.id, expectedRevision: task.revision, changes: { title: "Unapproved edit" } },
					new AbortController().signal,
				);
				await host.answer(status === "skipped", status);
				expect((await request).details).toEqual({ status: "cancelled" });
			}
			const controller = new AbortController();
			const request = host.schedules.tools.schedule_delete(
				host.ref,
				{ id: task.id, expectedRevision: task.revision },
				controller.signal,
			);
			await vi.waitFor(() => expect(host.interactions.list()).toHaveLength(1));
			const rejected = expect(request).rejects.toThrow("Cancelled fixture approval");
			controller.abort(new Error("Cancelled fixture approval"));
			await rejected;
			expect(host.interactions.list()).toEqual([]);
			expect((await host.read()).tasks).toEqual([task]);
		} finally {
			await host.close();
		}
	});

	it("keeps a task whose run starts while deletion awaits confirmation", async () => {
		const host = await harness({ pending: true });
		try {
			const task = (await host.read()).tasks[0]!;
			const request = host.schedules.tools.schedule_delete(
				host.ref,
				{ id: task.id, expectedRevision: task.revision },
				new AbortController().signal,
			);
			await vi.waitFor(() => expect(host.interactions.list()).toHaveLength(1));
			await host.schedules.run(task.id);
			await host.answer(true);
			await expect(request).rejects.toThrow("Stop the active run");
			expect((await host.read()).tasks[0]?.id).toBe(task.id);
		} finally {
			await host.close();
		}
	});
});
