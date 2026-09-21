import { randomUUID } from "node:crypto";
import { questionRecordSchema, type QuestionRecord, type QuestionsInput } from "@ling/contracts/questions";
import { sessionKey, type SessionRef } from "@ling/contracts/session-ref";
import { toError } from "@ling/core/ling-error";
import { createLogger } from "@ling/core/logger";
import { z } from "zod";
import { createFeatureStore } from "../companions/feature-store";
import { toolResult, type CompanionToolHandlers } from "../companions/tool-dispatch";
import type { Interactions } from "../interactions/interactions";

const log = createLogger("questions");
const failure = (value: unknown) => toError(value).message;

/** Keep the question context and the user's actual labels/text in the conversation, not transport IDs. */
function formatQuestionReply(
	request: Pick<QuestionsInput, "title" | "questions">,
	answer: NonNullable<QuestionRecord["answer"]>,
) {
	return [
		request.title,
		...answer.answers.map((entry) => {
			const question = request.questions.find((item) => item.id === entry.id);
			if (!question) throw new Error("Answer refers to an unknown question");
			const selected = entry.selected.map((id) => {
				const option = question.options?.find((item) => item.id === id);
				if (!option) throw new Error("Answer refers to an unknown option");
				return option.label;
			});
			return `${question.title}\n\n${[...selected, entry.text].filter((text) => text.trim()).join("\n")}`;
		}),
	].join("\n\n");
}

/** Questions the agent asks the user, retained with their answers and delivery state. */
export function createQuestions(options: {
	home: string;
	requireEnabled(): Promise<void>;
	interactions: Interactions;
	deliver(ref: SessionRef, requestId: string, text: string): Promise<void>;
	onChanged(ref: SessionRef | null): void;
}) {
	const store = createFeatureStore({
		home: options.home,
		directory: "ling-questions",
		key: "questions",
		schema: z.array(questionRecordSchema).max(100),
		initial: () => [],
	});
	const deliveries = new Map<string, Promise<void>>();
	const lifetime = new AbortController();
	const forSession = async (ref: SessionRef) =>
		(await store.read()).filter((item) => sessionKey(item.ref) === sessionKey(ref));
	async function update(id: string, patch: Partial<QuestionRecord>) {
		const items = await store.update((current) =>
			current.map((item) => (item.id === id ? { ...item, ...patch } : item)),
		);
		options.onChanged(items.find((item) => item.id === id)?.ref ?? null);
	}
	async function deliver(id: string, ref: SessionRef) {
		const existing = deliveries.get(id);
		if (existing) return existing;
		const operation = (async () => {
			const record = (await forSession(ref)).find((item) => item.id === id);
			if (!record || record.status !== "answered" || !record.answer) throw new Error("An explicit answer is required");
			if (record.delivery === "delivered") return;
			await update(id, { delivery: "sending", error: null });
			try {
				await options.deliver(ref, id, formatQuestionReply(record, record.answer));
				await update(id, { delivery: "delivered", error: null });
			} catch (error) {
				if (!lifetime.signal.aborted) await update(id, { delivery: "failed", error: failure(error) });
				throw error;
			}
		})();
		deliveries.set(id, operation);
		try {
			await operation;
		} finally {
			deliveries.delete(id);
		}
	}
	async function remember(ref: SessionRef, request: QuestionsInput) {
		await options.requireEnabled();
		const id = randomUUID();
		await store.update((items) => {
			const next: QuestionRecord[] = [
				...items,
				{
					id,
					ref,
					title: request.title,
					questions: request.questions,
					status: "pending",
					answer: null,
					delivery: "none",
					error: null,
					createdAt: Date.now(),
				},
			];
			// Retain complete answers with bounded history, never truncate a live answer.
			while (next.length > 100 || Buffer.byteLength(JSON.stringify(next)) > 4 * 1_048_576) {
				const at = next.findIndex((item) => item.status !== "pending" && item.delivery !== "sending");
				if (at < 0) throw new Error("Question history capacity is full");
				next.splice(at, 1);
			}
			return next;
		});
		options.onChanged(ref);
		return id;
	}
	async function ask(ref: SessionRef, request: QuestionsInput, id: string, signal: AbortSignal) {
		const answer = await options.interactions.request("questions", { ...request, ref, kind: "questions" }, signal);
		await update(id, { status: answer.status, answer });
		return answer;
	}
	const tools = {
		ask_user: async (ref, request, signal) => {
			const id = await remember(ref, request);
			try {
				const answer = await ask(ref, request, id, AbortSignal.any([signal, lifetime.signal]));
				if (answer.status === "answered") {
					try {
						await deliver(id, ref);
					} catch (error) {
						return toolResult({ ...answer, requestId: id, delivery: "failed", error: failure(error) });
					}
				}
				return toolResult(answer);
			} catch (error) {
				if (!lifetime.signal.aborted) await update(id, { status: "interrupted", error: failure(error) });
				throw error;
			}
		},
		ask_user_async: async (ref, request) => {
			const id = await remember(ref, request);
			void (async () => {
				try {
					const answer = await ask(ref, request, id, lifetime.signal);
					if (answer.status === "answered") await deliver(id, ref);
				} catch (error) {
					if (lifetime.signal.aborted) return;
					const record = (await forSession(ref)).find((item) => item.id === id);
					if (record?.status === "pending") await update(id, { status: "interrupted", error: failure(error) });
				}
			})().catch((error: unknown) => log.error("asynchronous question failed:", error));
			return toolResult({ id, status: "pending" });
		},
		question_result: async (ref, { id }) => {
			const record = (await forSession(ref)).find((item) => item.id === id);
			if (!record) throw new Error("Question is no longer available in this session");
			return toolResult(record);
		},
	} satisfies Pick<CompanionToolHandlers, "ask_user" | "ask_user_async" | "question_result">;
	return {
		tools,
		list: forSession,
		async retry(ref: SessionRef, id: string) {
			await deliver(id, ref);
		},
		/** Questions left pending by an earlier Host generation can no longer be answered. */
		async initialize() {
			await store.update((items) =>
				items.map((item) =>
					item.status === "pending"
						? { ...item, status: "interrupted", error: "Ling restarted before an answer was received" }
						: item.delivery === "sending"
							? { ...item, delivery: "failed", error: "Delivery was interrupted; retry reuses the original answer" }
							: item,
				),
			);
		},
		dispose() {
			lifetime.abort();
		},
	};
}
export type Questions = ReturnType<typeof createQuestions>;
