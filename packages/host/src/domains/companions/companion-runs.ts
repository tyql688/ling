import { randomUUID } from "node:crypto";
import type { CompanionRun, CompanionRunAdmission, CompanionRunRequest } from "@ling/contracts/companions";
import type { SessionRuntimePort } from "@ling/core/pi-protocol/runtime-port";
import { toError } from "@ling/core/ling-error";
import { createLogger } from "@ling/core/logger";

const log = createLogger("companion-runs");

/** Automatic agent runs started by Host features: at most one per session, tracked until they settle. */
export function createCompanionRuns(options: {
	assertProject(cwd: string): Promise<void>;
	prepareSession(input: CompanionRunRequest): Promise<SessionRuntimePort>;
}) {
	const runs = new Map<string, { runtime: SessionRuntimePort; value: CompanionRun; done: Promise<void> }>();
	const admissions = new Map<string, Promise<CompanionRunAdmission>>();
	const settledAdmissions = new Set<string>();
	function requireRun(runId: string) {
		const run = runs.get(runId);
		if (!run) throw new Error("Unknown run");
		return run;
	}
	return {
		start(input: CompanionRunRequest, signal: AbortSignal): Promise<CompanionRunAdmission> {
			const previous = admissions.get(input.requestId);
			if (previous) return previous;
			while (admissions.size >= 128 && settledAdmissions.size) {
				const oldest = settledAdmissions.values().next().value!;
				settledAdmissions.delete(oldest);
				admissions.delete(oldest);
			}
			if (admissions.size >= 256) throw new Error("Run history capacity reached; wait for active work to finish");
			const operation = (async (): Promise<CompanionRunAdmission> => {
				await options.assertProject(input.cwd);
				signal.throwIfAborted();
				const runtime = await options.prepareSession(input);
				signal.throwIfAborted();
				const runId = randomUUID();
				const cancel = () => {
					void runtime
						.cancelCompanionRun(runId)
						.catch((error: unknown) => log.error("run cancellation failed:", error));
				};
				signal.addEventListener("abort", cancel, { once: true });
				let value: CompanionRun | null;
				try {
					value = await runtime.startCompanionRun(runId, input.prompt, {
						...(input.model ? { model: input.model } : {}),
						...(input.thinking ? { thinking: input.thinking } : {}),
					});
				} finally {
					signal.removeEventListener("abort", cancel);
				}
				if (!value) return { status: "busy" };
				const record = { runtime, value, done: Promise.resolve() };
				runs.set(runId, record);
				record.done = runtime.waitCompanionRun(runId).then(
					(finished) => {
						record.value = finished;
					},
					(error: unknown) => {
						record.value = { ...record.value, status: "interrupted", error: toError(error).message };
					},
				);
				void record.done.then(() => {
					settledAdmissions.add(input.requestId);
					for (const [id, entry] of runs) if (runs.size > 128 && entry.value.status !== "running") runs.delete(id);
				});
				return { status: "started", run: value };
			})();
			admissions.set(input.requestId, operation);
			void operation.then(
				(result) => {
					if (result.status === "busy") admissions.delete(input.requestId);
				},
				() => {
					settledAdmissions.add(input.requestId);
				},
			);
			return operation;
		},
		async wait(runId: string) {
			const run = requireRun(runId);
			await run.done;
			return run.value;
		},
		async cancel(runId: string) {
			const run = requireRun(runId);
			const result = await run.runtime.cancelCompanionRun(runId);
			await run.done;
			return result;
		},
		async dispose() {
			const results = await Promise.allSettled(
				[...runs.values()]
					.filter((run) => run.value.status === "running")
					.map((run) => run.runtime.cancelCompanionRun(run.value.runId)),
			);
			const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
			if (failures.length) throw new AggregateError(failures, "Companion runs could not be cancelled");
		},
	};
}
export type CompanionRuns = ReturnType<typeof createCompanionRuns>;
