import { isTodoOrigin, todoDetailsSchema, todoProgress } from "@ling/contracts/todo";
import type { PiInlineExtension } from "../types";
import { createPiToolOrigins } from "./pi-tool-origin";

/** Gives a successful turn one chance to reconcile tasks it used without claiming that work succeeded. */
export function createPiTodoReconciliation() {
	return {
		name: "ling-todo-reconciliation",
		hidden: true,
		factory(pi) {
			let usedTodo = false;
			let reviewQueued = false;
			const reset = () => {
				usedTodo = false;
				reviewQueued = false;
			};
			pi.on("before_agent_start", reset);
			pi.on("agent_settled", reset);
			pi.on("session_start", reset);
			pi.on("session_tree", reset);
			pi.on("session_shutdown", reset);
			pi.on("tool_execution_end", (event) => {
				if (event.toolName === "todo" && !event.isError) usedTodo = true;
			});
			pi.on("agent_end", (event, ctx) => {
				if (
					!usedTodo ||
					reviewQueued ||
					ctx.signal?.aborted ||
					ctx.hasPendingMessages() ||
					!pi.getActiveTools().includes("todo")
				)
					return;
				const answer = event.messages.findLast((message) => message.role === "assistant");
				if (answer?.stopReason !== "stop") return;
				const entry = ctx.sessionManager
					.getBranch()
					.findLast(
						(item) => item.type === "message" && item.message.role === "toolResult" && item.message.toolName === "todo",
					);
				if (entry?.type !== "message" || entry.message.role !== "toolResult" || entry.message.isError) return;
				const origin = createPiToolOrigins(ctx.sessionManager)(entry.message.toolCallId, entry.id);
				if (!isTodoOrigin(origin ?? null)) return;
				const details = todoDetailsSchema.parse(entry.message.details);
				if (details.error || !todoProgress(details).open.length) return;
				// Do not reset at agent_start: retries, compaction and follow-ups share this request's budget.
				reviewQueued = true;
				pi.sendMessage(
					{
						customType: "ling:todo-reconciliation",
						display: false,
						content:
							"Before ending this request, reconcile the todo list you used with the work actually performed. Use the original todo tool to mark only tasks with clear completion evidence as completed. Leave incomplete, blocked, failed, cancelled, or explicitly deferred tasks unfinished. A reply ending is not completion evidence. Do not start remaining work or use other tools. If nothing can be updated, keep the list as it is. Briefly report only corrections or remaining blockers in the conversation's language.",
					},
					{ triggerTurn: true, deliverAs: "followUp" },
				);
			});
		},
	} satisfies PiInlineExtension;
}
