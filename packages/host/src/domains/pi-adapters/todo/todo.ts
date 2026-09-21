import type { UiLanguage } from "@ling/contracts/application";
import type { SessionRef } from "@ling/contracts/session-ref";
import { readTodoResult, todoProgress, type TodoSnapshot } from "@ling/contracts/todo";
import type { SessionRuntimePort } from "@ling/core/pi-protocol/runtime-port";
import { z } from "zod";
import type { CompanionRuns } from "../../companions/companion-runs";
import { hostWords, TODO_REVIEW_PROMPT } from "../../companions/host-words";

/** Ling's own checklist checkpoints in existing sessions are shown read-only. */
const LEGACY_CHECKPOINT_TYPE = "ling-plugin:ling-todo";
const legacyCheckpointSchema = z.object({
	items: z
		.array(
			z.object({
				id: z.string(),
				title: z.string(),
				description: z.string(),
				status: z.enum(["pending", "in_progress", "done", "cancelled"]),
				dependsOn: z.array(z.string()),
			}),
		)
		.nullable(),
});

/** Read-only projection of rpiv-todo's latest result plus a follow-up run that reconciles unfinished work. */
export function createTodo(options: {
	requireEnabled(): Promise<void>;
	requireSession(ref: SessionRef): SessionRuntimePort;
	runs: CompanionRuns;
}) {
	return {
		async snapshot(ref: SessionRef): Promise<TodoSnapshot> {
			const runtime = options.requireSession(ref);
			const value = readTodoResult(await runtime.readLatestToolResult("todo"));
			const checkpoint = await runtime.readCustomEntry(LEGACY_CHECKPOINT_TYPE);
			return { value, legacy: checkpoint === null ? null : legacyCheckpointSchema.parse(checkpoint).items };
		},
		async review(ref: SessionRef, requestId: string, language: UiLanguage | undefined, signal: AbortSignal) {
			await options.requireEnabled();
			const value = readTodoResult(await options.requireSession(ref).readLatestToolResult("todo"));
			if (!value || !todoProgress(value).open.length) return;
			const admission = await options.runs.start(
				{ cwd: ref.cwd, sessionId: ref.sessionId, requestId, prompt: hostWords(language)(TODO_REVIEW_PROMPT) },
				signal,
			);
			if (admission.status === "busy")
				throw new Error("The agent is already working. Wait for it to finish before checking progress.");
		},
	};
}
export type Todo = ReturnType<typeof createTodo>;
