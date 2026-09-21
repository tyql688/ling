import { rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import type { CompanionRun, CompanionRunAdmission } from "@ling/contracts/companions";
import { createInteractions } from "../interactions/interactions";
import { createSchedules } from "./schedules";
import { createBuiltinFeatures } from "../companions/builtin-features";
import { temporaryDirectory } from "../../../../../test/temporary-directory";

async function harness(options: { pending?: boolean; missed?: "skip" | "latest" } = {}) {
	const home = await temporaryDirectory("schedules");
	const features = createBuiltinFeatures(home);
	const cancelled = vi.fn();
	const ref = { cwd: "/example", sessionId: "session" };
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
		interactions: createInteractions(() => undefined),
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
		read: () => schedules.snapshot(),
		async close() {
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
