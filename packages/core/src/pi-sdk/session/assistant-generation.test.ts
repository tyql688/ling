import { rm } from "node:fs/promises";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { temporaryDirectory } from "../../../../../test/temporary-directory";
import { createAssistantGeneration, readAssistantGeneration } from "./assistant-generation";
import { normalizePiMessage } from "./message-normalizer";

type Message = Extract<Parameters<ReturnType<typeof createAssistantGeneration>["finish"]>[1], { role: "assistant" }>;
function answer(timestamp = 1): Message {
	return {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		api: "openai-responses",
		provider: "openai",
		model: "test",
		stopReason: "stop",
		timestamp,
		usage: {
			input: 10,
			output: 100,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 110,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

afterEach(() => vi.restoreAllMocks());

describe("assistant generation measurements", () => {
	it("times first nonempty thinking/text output through completion, then restores the same reading from disk and a fork", async () => {
		const root = await temporaryDirectory("generation");
		try {
			const manager = SessionManager.create(root, join(root, "sessions"));
			manager.appendMessage({ role: "user", content: "test", timestamp: 1 });
			const tracker = createAssistantGeneration(manager);
			let time = 0;
			vi.spyOn(performance, "now").mockImplementation(() => time);
			const message = answer();
			tracker.start("a");
			time = 500;
			tracker.update("a", { type: "thinking_delta", contentIndex: 0, delta: "", partial: message });
			time = 2_000;
			tracker.update("a", { type: "thinking_delta", contentIndex: 0, delta: "reason", partial: message });
			time = 3_000;
			tracker.update("a", { type: "text_delta", contentIndex: 0, delta: "done", partial: message });
			time = 4_000;
			tracker.finish("a", message);
			const id = manager.appendMessage(message);
			const live = normalizePiMessage(tracker.project(message, null), { messageId: "a", entryId: null, occurredAt: 1 });
			expect(live).toMatchObject({ role: "assistant", generationDurationMs: 2_000 });
			expect(message).not.toHaveProperty("generationDurationMs");
			const restored = SessionManager.open(manager.getSessionFile()!);
			expect(readAssistantGeneration(restored, id)).toBe(2_000);
			restored.appendMessage(answer(2));
			restored.branch(id);
			expect(readAssistantGeneration(restored, id)).toBe(2_000);
			const fork = SessionManager.open(restored.createBranchedSession(id)!);
			expect(readAssistantGeneration(fork, id)).toBe(2_000);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	it("keeps retries, tool execution gaps, old history and disposed attempts out of another message's rate", () => {
		const manager = SessionManager.inMemory("/project");
		const tracker = createAssistantGeneration(manager);
		let time = 1_000;
		vi.spyOn(performance, "now").mockImplementation(() => time);
		const message = answer();
		tracker.start("failed");
		tracker.update("failed", { type: "text_delta", contentIndex: 0, delta: "partial", partial: message });
		tracker.finish("failed", { ...message, stopReason: "aborted" });
		time = 20_000;
		tracker.start("retry");
		tracker.update("failed", { type: "text_delta", contentIndex: 0, delta: "late", partial: message });
		time = 40_000;
		tracker.update("retry", {
			type: "toolcall_start",
			contentIndex: 0,
			partial: { ...message, content: [{ type: "toolCall", id: "call", name: "read", arguments: {} }] },
		});
		time = 41_000;
		tracker.finish("retry", message);
		const id = manager.appendMessage(message);
		expect(readAssistantGeneration(manager, id)).toBe(1_000);
		const legacy = manager.appendMessage(answer(2));
		expect(readAssistantGeneration(manager, legacy)).toBeUndefined();
		tracker.start("disposed");
		tracker.update("disposed", { type: "text_delta", contentIndex: 0, delta: "later", partial: message });
		tracker.clear();
		tracker.finish("disposed", answer(3));
		expect(manager.getLeafId()).toBe(legacy);
	});
	it("does not infer a duration when no token delta or no usage was received", () => {
		const manager = SessionManager.inMemory("/project");
		const tracker = createAssistantGeneration(manager);
		tracker.start("a");
		tracker.finish("a", answer());
		expect(manager.getEntries()).toHaveLength(0);
		const unknown = answer(2);
		unknown.usage.output = 0;
		tracker.start("b");
		tracker.update("b", { type: "toolcall_delta", contentIndex: 0, delta: "{}", partial: unknown });
		tracker.finish("b", unknown);
		expect(manager.getEntries()).toHaveLength(0);
	});
});
