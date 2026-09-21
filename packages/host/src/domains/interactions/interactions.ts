import { randomUUID } from "node:crypto";
import {
	interactionAnswerSchema,
	type Interaction,
	type InteractionAnswer,
	type InteractionRequest,
} from "@ling/contracts/companions";
import type { SessionRef } from "@ling/contracts/session-ref";

/** Questions and approvals a feature is waiting on; each pending request retains its session runtime. */
export function createInteractions(onChanged: (requests: Interaction[]) => void) {
	const pending = new Map<
		string,
		{ request: Interaction; resolve(value: InteractionAnswer): void; reject(error: unknown): void }
	>();
	const answered = new Map<string, { submissionId: string; value: string }>();
	const snapshot = () => [...pending.values()].map((entry) => entry.request);
	const publish = () => onChanged(snapshot());
	return {
		list: snapshot,
		refs: (): SessionRef[] => snapshot().map((item) => item.ref),
		async request(feature: string, input: InteractionRequest, signal: AbortSignal): Promise<InteractionAnswer> {
			signal.throwIfAborted();
			// Limit waiting work independently of visible cards; each request retains a live continuation.
			if (pending.size >= 64) throw new Error("Too many unanswered requests");
			const id = randomUUID();
			const result = Promise.withResolvers<InteractionAnswer>();
			const request: Interaction = {
				id,
				feature,
				ref: input.ref,
				kind: input.kind,
				title: input.title,
				body: input.body ?? "",
				questions: input.questions ?? [],
				createdAt: Date.now(),
			};
			const cancel = () => result.reject(signal.reason);
			pending.set(id, { request, ...result });
			signal.addEventListener("abort", cancel, { once: true });
			publish();
			try {
				return await result.promise;
			} finally {
				signal.removeEventListener("abort", cancel);
				pending.delete(id);
				publish();
			}
		},
		answer(id: string, submissionId: string, value: InteractionAnswer) {
			const answer = interactionAnswerSchema.parse(value);
			const existing = answered.get(id);
			if (existing?.submissionId === submissionId && existing.value === JSON.stringify(answer)) return;
			const entry = pending.get(id);
			if (!entry || existing) throw new Error("This request has already ended");
			if (answer.status === "answered") {
				if (entry.request.kind === "questions") {
					if (
						answer.answers.length !== entry.request.questions.length ||
						new Set(answer.answers.map((item) => item.id)).size !== answer.answers.length
					)
						throw new Error("Answer each question once");
					for (const question of entry.request.questions) {
						const response = answer.answers.find((item) => item.id === question.id);
						if (!response || (!response.text.trim() && !response.selected.length))
							throw new Error("Every question needs an answer");
						if (
							response.selected.some((selected) => !question.options?.some((option) => option.id === selected)) ||
							new Set(response.selected).size !== response.selected.length
						)
							throw new Error("An answer contains an unavailable option");
						if (!question.multiple && response.selected.length > 1) throw new Error("Choose at most one option");
					}
				} else if (typeof answer.approved !== "boolean")
					throw new Error("An explicit approval or rejection is required");
			}
			answered.set(id, { submissionId, value: JSON.stringify(answer) });
			while (answered.size > 128) answered.delete(answered.keys().next().value!);
			entry.resolve(answer);
		},
		dispose() {
			for (const entry of pending.values()) entry.reject(new Error("Ling is stopping"));
		},
	};
}
export type Interactions = ReturnType<typeof createInteractions>;
