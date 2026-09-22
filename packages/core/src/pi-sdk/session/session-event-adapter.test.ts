import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { LingSessionEvent } from "@ling/contracts/session";
import { afterEach, expect, it, vi } from "vitest";
import type { PiAgentSession } from "../types";
import { createPiSessionEventAdapter } from "./session-event-adapter";
import { projectPiBranchMessages, summarizePiBranchMessages } from "./session-message-projector";

afterEach(() => vi.useRealTimers());

function streamingAdapter() {
	const events: LingSessionEvent[] = [];
	const transform = vi.fn((text: string) => text);
	const failure = vi.fn();
	const deliver = vi.fn((event: LingSessionEvent) => {
		events.push(event);
	});
	const sessionManager = SessionManager.inMemory("/project");
	const session = {
		sessionManager,
		extensionRunner: { getMarkdownTransformers: () => [transform] },
	} as unknown as PiAgentSession;
	const adapter = createPiSessionEventAdapter({
		session,
		onDeferredEvent: deliver,
		onDeferredError: failure,
		getMarkdownWidth: () => 88,
		queueMirror: () => ({ unpark: () => Promise.resolve() }) as never,
	});
	type Message = Extract<Parameters<typeof adapter.adapt>[0], { type: "message_update" }>["message"];
	const message: Message = {
		role: "assistant",
		content: [{ type: "text", text: "" }],
		api: "openai-responses",
		provider: "test",
		model: "test",
		stopReason: "stop",
		timestamp: 1,
		usage: {
			input: 0,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 1,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	const start = adapter.adapt({ type: "message_start", message });
	const update = (text: string) => {
		message.content = [{ type: "text", text }];
		return adapter.adapt({
			type: "message_update",
			message,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text, partial: message },
		});
	};
	return { adapter, events, transform, failure, deliver, message, start, update };
}

it("coalesces token bursts before extension projection and flushes the last text before a tool boundary", () => {
	vi.useFakeTimers();
	const h = streamingAdapter();
	try {
		h.transform.mockClear();
		for (let i = 0; i < 100; i++) expect(h.update(`中文😀 ${i}`)).toBeNull();
		expect(h.transform).not.toHaveBeenCalled();
		expect(h.events).toEqual([]);
		vi.advanceTimersByTime(16);
		expect(h.transform).toHaveBeenCalledTimes(1);
		expect(h.events).toMatchObject([
			{ type: "messageUpdate", streamMode: "full", message: { content: [{ text: "中文😀 99" }] } },
		]);
		h.update("final text");
		const tool = h.adapter.adapt({ type: "tool_execution_start", toolCallId: "tool", toolName: "read", args: {} });
		expect(tool?.type).toBe("toolExecutionChanged");
		expect(h.events.at(-1)).toMatchObject({ type: "messageUpdate", message: { content: [{ text: "final text" }] } });
		expect(h.events[0]).toMatchObject({ message: { content: [{ text: "中文😀 99" }] } });
		expect(vi.getTimerCount()).toBe(0);
	} finally {
		h.adapter.dispose();
	}
});

it("keeps first-token timing and message identity when a short answer finishes before the display timer", () => {
	vi.useFakeTimers();
	const h = streamingAdapter();
	try {
		vi.spyOn(performance, "now").mockReturnValue(100);
		h.update("first");
		vi.mocked(performance.now).mockReturnValue(150);
		h.update("complete");
		const ended = h.adapter.adapt({ type: "message_end", message: h.message });
		if (h.start?.type !== "messageStart") throw new Error("Missing start");
		expect(h.events).toMatchObject([
			{ type: "messageUpdate", message: { id: h.start.message.id, content: [{ text: "complete" }] } },
		]);
		expect(ended).toMatchObject({
			type: "messageEnd",
			message: { id: h.start.message.id, generationDurationMs: 50, content: [{ text: "complete" }] },
		});
		expect(vi.getTimerCount()).toBe(0);
	} finally {
		h.adapter.dispose();
	}
});

it("discards a retired subscription's pending text and preserves isolated transformer failures", () => {
	vi.useFakeTimers();
	const retired = streamingAdapter();
	retired.update("retired");
	retired.adapter.dispose();
	vi.advanceTimersByTime(16);
	retired.update("late");
	vi.advanceTimersByTime(16);
	expect(retired.events).toEqual([]);
	const active = streamingAdapter();
	try {
		const error = new Error("Extension projection is unavailable");
		active.transform.mockImplementation(() => {
			throw error;
		});
		// Transformer failures are isolated by Pi's display contract; a delivery failure belongs to the runtime.
		active.update("readable");
		vi.advanceTimersByTime(16);
		expect(active.events).toMatchObject([{ type: "messageUpdate", message: { content: [{ text: "readable" }] } }]);
		expect(active.failure).not.toHaveBeenCalled();
		active.deliver.mockImplementation(() => {
			throw error;
		});
		active.update("undeliverable");
		vi.advanceTimersByTime(16);
		expect(active.failure).toHaveBeenCalledWith(error);
	} finally {
		active.adapter.dispose();
	}
});

it("keeps retained live message identities distinct after replacing the event subscription", async () => {
	const sessionManager = SessionManager.inMemory("/project");
	const session = {
		sessionManager,
		extensionRunner: { getMarkdownTransformers: () => [] },
	} as unknown as PiAgentSession;
	const retainedIds = new Set<string>();
	for (let subscription = 0; subscription < 2; subscription++) {
		const deferred: LingSessionEvent[] = [];
		const adapter = createPiSessionEventAdapter({
			session,
			onDeferredEvent: (event) => deferred.push(event),
			onDeferredError: (error) => {
				throw error;
			},
			getMarkdownWidth: () => 88,
			queueMirror: () => {
				throw new Error("User message projection does not access the model queue");
			},
		});
		try {
			for (let turn = 0; turn < 2; turn++) {
				const message = { role: "user" as const, content: `Subscription ${subscription}, turn ${turn}`, timestamp: 1 };
				const started = adapter.adapt({ type: "message_start", message });
				if (started?.type !== "messageStart") throw new Error("Expected messageStart");
				expect(retainedIds.has(started.message.id)).toBe(false);
				retainedIds.add(started.message.id);
				const ended = adapter.adapt({ type: "message_end", message });
				expect(ended).toMatchObject({ type: "messageEnd", message: { id: started.message.id } });
				const entryId = sessionManager.appendMessage(message);
				await new Promise<void>((resolve) => queueMicrotask(resolve));
				expect(deferred.at(-1)).toEqual({ type: "messagePersisted", messageId: started.message.id, entryId });
			}
		} finally {
			adapter.dispose();
		}
	}
});

it("retains SDK system entries without turning prompt/tool metadata into live or replayed chat rows", async () => {
	const sessionManager = SessionManager.inMemory("/project");
	const session = { sessionManager } as PiAgentSession;
	const deferred: LingSessionEvent[] = [];
	const adapter = createPiSessionEventAdapter({
		session,
		onDeferredEvent: (event) => deferred.push(event),
		onDeferredError: (error) => {
			throw error;
		},
		getMarkdownWidth: () => 88,
		queueMirror: () => {
			throw new Error("System metadata must not change the user queue");
		},
	});
	try {
		const system = {
			role: "system" as const,
			content: "Private model instructions",
			toolsRemoved: [{ name: "write" }],
			timestamp: 1,
		};
		expect(adapter.adapt({ type: "message_start", message: system })).toBeNull();
		expect(adapter.adapt({ type: "message_end", message: system })).toBeNull();
		sessionManager.appendMessage(system);
		const userId = sessionManager.appendMessage({ role: "user", content: "Visible question", timestamp: 2 });
		await new Promise<void>((resolve) => queueMicrotask(resolve));
		expect(deferred).toEqual([]);
		expect(sessionManager.getBranch()).toHaveLength(2);
		expect(projectPiBranchMessages({ sessionManager, extensions: null })).toMatchObject([
			{ role: "user", id: `entry:${userId}` },
		]);
		expect(summarizePiBranchMessages(session)).toEqual({ messageCount: 1, preview: "Visible question" });
		sessionManager.appendContextEdit(userId, null);
		const secondId = sessionManager.appendMessage({ role: "user", content: "Original follow-up", timestamp: 3 });
		sessionManager.appendContextEdit(secondId, { content: "Shortened provider context" });
		// Context edits affect provider input, while Ling's transcript keeps original messages and identities.
		expect(sessionManager.buildSessionContext().messages.filter((message) => message.role === "user")).toEqual([
			expect.objectContaining({ content: "Shortened provider context" }),
		]);
		expect(projectPiBranchMessages({ sessionManager, extensions: null })).toMatchObject([
			{ role: "user", id: `entry:${userId}`, content: "Visible question" },
			{ role: "user", id: `entry:${secondId}`, content: "Original follow-up" },
		]);
		expect(summarizePiBranchMessages(session)).toEqual({ messageCount: 2, preview: "Visible question" });
	} finally {
		adapter.dispose();
	}
});
