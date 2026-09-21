import type { CompanionRun, CompanionRunRequest, ToolResultSnapshot } from "@ling/contracts/companions";
import { z } from "zod";
import { createPiToolOrigins } from "../extensions/pi-tool-origin";
import { createLogger } from "../../logger";
import type { PiAgentSession } from "../types";
import type { PiRuntimeOperationCoordinator } from "./runtime-operations";
import { toError } from "../../ling-error";

const log = createLogger("companion-session-services");
/** Tool details larger than this stay in the conversation view instead of a feature projection. */
const TOOL_SNAPSHOT_MAX_BYTES = 4 * 1_048_576;

/** Session-side services for Host features: answer delivery, tool result reads and automatic runs. */
export function createRuntimeCompanionServices(host: {
	session(): PiAgentSession;
	operations: PiRuntimeOperationCoordinator;
	isBusy(): boolean;
	emitSnapshotChanged(): void;
}) {
	let active: string | null = null;
	const runs = new Map<
		string,
		{ value: CompanionRun; done: Promise<void>; cancel: boolean; admitted: boolean; session: PiAgentSession }
	>();
	const replies = new Map<string, Promise<void>>();
	return {
		/** Delivers a user's answer as a steer message; the durable custom message prevents a second delivery. */
		async deliverReply(requestId: string, text: string) {
			const session = host.session();
			const key = JSON.stringify([session.sessionId, requestId]);
			const existing = replies.get(key);
			if (existing) return existing;
			const customType = `ling-answer:questions:${requestId}`;
			if (
				session.sessionManager
					.getBranch()
					.some((entry) => entry.type === "custom_message" && entry.customType === customType)
			)
				return;
			const operation = host.operations.runPrompt(async () => {
				if (session !== host.session()) throw new Error("The answer's session was replaced");
				await session.sendCustomMessage(
					{ customType, content: text, display: true, details: { feature: "questions", requestId } },
					{ triggerTurn: true, deliverAs: "steer" },
				);
				host.emitSnapshotChanged();
			});
			replies.set(key, operation);
			while (replies.size > 128) replies.delete(replies.keys().next().value!);
			try {
				await operation;
			} catch (error) {
				if (replies.get(key) === operation) replies.delete(key);
				throw error;
			}
		},
		async readLatestToolResult(toolName: string): Promise<ToolResultSnapshot | null> {
			return host.operations.runSynchronously("read tool result", () => {
				const session = host.session();
				const manager = session.sessionManager;
				const entry = manager
					.getBranch()
					.findLast(
						(item) =>
							item.type === "message" && item.message.role === "toolResult" && item.message.toolName === toolName,
					);
				const persisted = entry?.type === "message" && entry.message.role === "toolResult" ? entry.message : null;
				// Pi finalizes agent state before extension message_end, and appends after listeners return.
				// Compacted context may omit older results; branch history remains the durable fallback.
				const live = session.agent.state.messages.findLast(
					(item) => item.role === "toolResult" && item.toolName === toolName,
				);
				const message = live?.role === "toolResult" ? live : persisted;
				if (!message) return null;
				const result: ToolResultSnapshot = {
					toolCallId: message.toolCallId,
					origin:
						createPiToolOrigins(manager)(
							message.toolCallId,
							message.toolCallId === persisted?.toolCallId && message.timestamp === persisted.timestamp
								? entry!.id
								: null,
						) ?? null,
					details: message.details === undefined ? null : z.json().parse(message.details),
					isError: message.isError,
				};
				if (Buffer.byteLength(JSON.stringify(result)) > TOOL_SNAPSHOT_MAX_BYTES)
					throw new Error("Tool details exceed the view limit; read the original result in the conversation");
				return result;
			});
		},
		/** The latest custom entry of a type on the current branch, or null when none was recorded. */
		async readCustomEntry(customType: string) {
			return host.operations.runSynchronously("read custom entry", () => {
				const latest = host
					.session()
					.sessionManager.getBranch()
					.findLast((entry) => entry.type === "custom" && entry.customType === customType);
				return latest?.type === "custom" ? z.json().parse(latest.data) : null;
			});
		},
		async startCompanionRun(
			runId: string,
			text: string,
			configuration: Pick<CompanionRunRequest, "model" | "thinking">,
		): Promise<CompanionRun | null> {
			const existing = runs.get(runId);
			if (existing) return { ...existing.value };
			if (active || host.isBusy()) return null;
			const session = host.session();
			if (!session.isIdle || session.pendingMessageCount > 0) return null;
			// Keep a bounded completion history while preserving the one active owner.
			for (const [id, run] of runs) if (runs.size >= 100 && run.value.status !== "running") runs.delete(id);
			const admission = Promise.withResolvers<CompanionRun>();
			const settled = Promise.withResolvers<void>();
			const value: CompanionRun = {
				runId,
				ref: { cwd: session.sessionManager.getCwd(), sessionId: session.sessionManager.getSessionId() },
				status: "running",
				error: null,
				tokens: 0,
				text: "",
			};
			const run = { value, done: settled.promise, cancel: false, admitted: false, session };
			runs.set(runId, run);
			active = runId;
			let admitted = false;
			const unsubscribe = session.subscribe((event) => {
				if (event.type !== "agent_end") return;
				for (const message of event.messages) {
					if (message.role !== "assistant") continue;
					run.value.tokens += message.usage.totalTokens;
					run.value.text = message.content
						.filter((part) => part.type === "text")
						.map((part) => part.text)
						.join("\n")
						.slice(-32_768);
					if (message.stopReason === "error" || message.stopReason === "aborted")
						run.value.error = message.errorMessage ?? message.stopReason;
				}
			});
			void host.operations
				.runPrompt(async () => {
					if (run.cancel || host.session() !== session || !session.isIdle || host.operations.activePromptCount > 1)
						throw new Error("Session admission changed before the automatic run");
					if (configuration.model || configuration.thinking)
						await host.operations.runOrderedMutation(async () => {
							if (run.cancel || host.session() !== session || !session.isIdle || host.operations.activePromptCount > 1)
								throw new Error("Session admission changed before automatic configuration");
							if (configuration.model) {
								const model = session.modelRuntime.getModel(configuration.model.provider, configuration.model.id);
								if (!model) throw new Error("Configured schedule model is unavailable");
								await session.setModel(model);
							}
							if (configuration.thinking) session.setThinkingLevel(configuration.thinking);
						});
					if (
						run.cancel ||
						host.session() !== session ||
						!session.isIdle ||
						session.pendingMessageCount > 0 ||
						host.operations.activePromptCount > 1
					)
						throw new Error("Automatic admission was cancelled or superseded");
					await session.prompt(text, {
						source: "extension",
						expandPromptTemplates: false,
						preflightResult(ok) {
							if (ok) {
								if (run.cancel) throw new Error("Automatic run cancelled during preflight");
								admitted = true;
								run.admitted = true;
								admission.resolve({ ...run.value });
							}
						},
					});
				})
				.then(
					() => {
						run.value.status = run.cancel ? "cancelled" : run.value.error ? "failed" : "completed";
					},
					(error: unknown) => {
						run.value.error = toError(error).message;
						run.value.status = run.cancel ? "cancelled" : "failed";
						if (!admitted) admission.reject(error);
					},
				)
				.finally(() => {
					unsubscribe();
					if (active === runId) active = null;
					if (!admitted) admission.reject(new Error("The prompt did not start a model run"));
					settled.resolve();
					host.emitSnapshotChanged();
				})
				.catch((error: unknown) => log.error("Companion run cleanup failed:", error));
			return admission.promise;
		},
		async waitCompanionRun(runId: string) {
			const run = runs.get(runId);
			if (!run) throw new Error("This run no longer belongs to the session runtime");
			await run.done;
			return { ...run.value };
		},
		async cancelCompanionRun(runId: string) {
			const run = runs.get(runId);
			if (!run) throw new Error("This run no longer belongs to the session runtime");
			if (active === runId && run.value.status === "running" && host.session() === run.session) {
				run.cancel = true;
				if (run.admitted) await run.session.abort();
				await run.done;
			}
			return { ...run.value };
		},
	};
}
