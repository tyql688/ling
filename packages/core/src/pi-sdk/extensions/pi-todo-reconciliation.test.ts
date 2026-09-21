import {
	SessionManager,
	type AgentEndEvent,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionEvent,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createPiTodoReconciliation } from "./pi-todo-reconciliation";

type Answer = Extract<AgentEndEvent["messages"][number], { role: "assistant" }>;
type ToolDetails = Extract<AgentEndEvent["messages"][number], { role: "toolResult" }>["details"];
function answer(stopReason: Answer["stopReason"] = "stop"): Answer {
	return {
		role: "assistant",
		content: [{ type: "text", text: "Work finished; another task is blocked." }],
		api: "openai-completions",
		provider: "test",
		model: "test",
		stopReason,
		timestamp: 1,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

function fixture() {
	const manager = SessionManager.inMemory("/project");
	const handlers = new Map<string, (event: ExtensionEvent, ctx: ExtensionContext) => unknown>();
	const sendMessage = vi.fn();
	const controls = { pending: false, tools: ["todo"] };
	const controller = new AbortController();
	createPiTodoReconciliation().factory({
		on(name: string, handler: (event: ExtensionEvent, ctx: ExtensionContext) => unknown) {
			handlers.set(name, handler);
		},
		getActiveTools: () => controls.tools,
		sendMessage,
	} as unknown as ExtensionAPI);
	const ctx = {
		sessionManager: manager,
		signal: controller.signal,
		hasPendingMessages: () => controls.pending,
	} as unknown as ExtensionContext;
	const emit = (event: ExtensionEvent) => handlers.get(event.type)?.(event, ctx);
	const start = () => {
		manager.appendMessage({ role: "user", content: "Do the work", timestamp: 1 });
		emit({
			type: "before_agent_start",
			prompt: "Do the work",
			systemPrompt: "",
			systemPromptOptions: {
				cwd: "/project",
				selectedTools: [],
				toolSnippets: {},
				toolGuidelines: {},
				promptGuidelines: [],
				appendSystemPrompt: "",
				sections: {},
				contextFiles: [],
				skills: [],
			},
		});
	};
	let nextCall = 0;
	const todo = (
		details: ToolDetails = { tasks: [{ id: 1, subject: "Work", status: "in_progress" }], nextId: 2 },
		source: string | null = "ling:todo",
	) => {
		const toolCallId = `call-${++nextCall}`;
		manager.appendMessage(answer("toolUse"));
		if (source)
			manager.appendCustomEntry("ling:pi-tool-origin:v1", {
				toolCallId,
				origin: { source, extension: "index.ts", scope: "global", version: "2.10.1", revision: "a".repeat(64) },
			});
		manager.appendMessage({
			role: "toolResult",
			toolName: "todo",
			toolCallId,
			content: [],
			details,
			isError: false,
			timestamp: 1,
		});
		emit({
			type: "tool_execution_end",
			toolName: "todo",
			toolCallId,
			result: { content: [], details },
			isError: false,
		});
	};
	const finish = (stopReason: Answer["stopReason"] = "stop") => {
		const message = answer(stopReason);
		manager.appendMessage(message);
		return emit({ type: "agent_end", messages: [message] });
	};
	start();
	return { manager, sendMessage, controls, controller, emit, start, todo, finish };
}

describe("Todo reconciliation", () => {
	it("queues one original-tool review per request without completing blocked work or looping on follow-ups", () => {
		const f = fixture();
		f.todo();
		f.finish();
		expect(f.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ customType: "ling:todo-reconciliation", display: false }),
			{ triggerTurn: true, deliverAs: "followUp" },
		);
		f.emit({ type: "agent_start" });
		f.todo();
		f.finish();
		expect(f.sendMessage).toHaveBeenCalledTimes(1);
		expect(
			f.manager
				.getBranch()
				.filter((entry) => entry.type === "message" && entry.message.role === "toolResult")
				.at(-1),
		).toMatchObject({ message: { details: { tasks: [{ status: "in_progress" }] } } });
		f.emit({ type: "agent_settled" });
		f.start();
		f.finish();
		expect(f.sendMessage).toHaveBeenCalledTimes(1);
		f.todo();
		f.finish();
		expect(f.sendMessage).toHaveBeenCalledTimes(2);
	});

	it("does not revive completed or deleted tasks", () => {
		const f = fixture();
		f.todo({
			tasks: [
				{ id: 1, subject: "Done", status: "completed" },
				{ id: 2, subject: "Removed", status: "deleted" },
			],
			nextId: 3,
		});
		f.finish();
		expect(f.sendMessage).not.toHaveBeenCalled();
	});

	it.each([null, "npm:another-todo", "npm:@juicesharp/rpiv-todo@2.10.1"])(
		"checks recorded ownership for %s",
		(source) => {
			const f = fixture();
			f.todo(undefined, source);
			f.finish();
			expect(f.sendMessage).toHaveBeenCalledTimes(source === "npm:@juicesharp/rpiv-todo@2.10.1" ? 1 : 0);
		},
	);

	it("waits for a successful retry and never resets its budget at agent_start", () => {
		const f = fixture();
		f.todo();
		f.finish("error");
		f.emit({ type: "agent_start" });
		f.finish("length");
		expect(f.sendMessage).not.toHaveBeenCalled();
		f.emit({ type: "agent_start" });
		f.finish();
		expect(f.sendMessage).toHaveBeenCalledTimes(1);
	});

	it.each(["abort", "pending", "inactive", "aborted-response"] as const)("does not continue after %s", (reason) => {
		const f = fixture();
		f.todo();
		if (reason === "abort") f.controller.abort();
		if (reason === "pending") f.controls.pending = true;
		if (reason === "inactive") f.controls.tools = [];
		f.finish(reason === "aborted-response" ? "aborted" : "stop");
		expect(f.sendMessage).not.toHaveBeenCalled();
	});

	it("does not interpret invalid or failed Todo output as an empty successful list", () => {
		const f = fixture();
		f.todo({ tasks: "broken" });
		expect(() => f.finish()).toThrow();
		f.todo({ tasks: [{ id: 1, subject: "Work", status: "pending" }], nextId: 2, error: "State unavailable" });
		f.finish();
		expect(f.sendMessage).not.toHaveBeenCalled();
	});
});
