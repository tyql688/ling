import { rm } from "node:fs/promises";
import { join } from "node:path";
import { temporaryDirectory } from "../../../../../test/temporary-directory";
import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { PiAgentSession } from "../types";
import { createPiRuntimeOperationCoordinator } from "./runtime-operations";
import { createRuntimeCompanionServices } from "./runtime-companion-services";

describe("companion session services", () => {
	it("reads finalized tool details before append and resolves older results against their own branch", async () => {
		const manager = SessionManager.inMemory("/project");
		const origin = {
			source: "ling:ling-todo",
			extension: "pi.js",
			scope: "global",
			version: "1.0.0",
			revision: "a".repeat(64),
		};
		manager.appendMessage({ role: "user", content: "todo", timestamp: 1 });
		manager.appendCustomEntry("ling:pi-tool-origin:v1", { toolCallId: "call", origin });
		const message = {
			role: "toolResult" as const,
			toolName: "todo",
			toolCallId: "call",
			content: [{ type: "text" as const, text: "Created" }],
			details: { tasks: [], nextId: 1 },
			timestamp: 2,
			isError: false,
		};
		const messages: (typeof message)[] = [message];
		const service = createRuntimeCompanionServices({
			session: () => ({ sessionManager: manager, agent: { state: { messages } } }) as unknown as PiAgentSession,
			operations: createPiRuntimeOperationCoordinator({
				assertCanStart() {},
				getActiveReload: () => null,
				assertCanRunSynchronously() {},
				onReleased() {},
			}),
			isBusy: () => false,
			emitSnapshotChanged() {},
		});
		expect(await service.readLatestToolResult("todo")).toMatchObject({ origin, details: message.details });
		const entry = manager.appendMessage(message);
		manager.appendMessage({ role: "user", content: "next turn", timestamp: 3 });
		expect(await service.readLatestToolResult("todo")).toMatchObject({ origin });
		messages.splice(0);
		expect(await service.readLatestToolResult("todo")).toMatchObject({ origin });
		manager.branch(manager.getEntry(entry)!.parentId!);
		expect(await service.readLatestToolResult("todo")).toBeNull();
	});
	it("retries failed answer admission but deduplicates an answer already saved by Pi", async () => {
		const directory = await temporaryDirectory("question-answer");
		try {
			const manager = SessionManager.create(directory, join(directory, "sessions"));
			let attempts = 0;
			const session = {
				sessionId: manager.getSessionId(),
				sessionManager: manager,
				async sendCustomMessage(message: { customType: string; content: string; details: unknown }, delivery: unknown) {
					expect(delivery).toEqual({ triggerTurn: true, deliverAs: "steer" });
					attempts++;
					if (attempts === 1) throw new Error("admission unavailable");
					manager.appendCustomMessageEntry(message.customType, message.content, true, message.details);
					throw new Error("model failed after append");
				},
			} as unknown as PiAgentSession;
			const service = createRuntimeCompanionServices({
				session: () => session,
				operations: createPiRuntimeOperationCoordinator({
					assertCanStart() {},
					getActiveReload: () => null,
					assertCanRunSynchronously() {},
					onReleased() {},
				}),
				isBusy: () => false,
				emitSnapshotChanged() {},
			});
			await expect(service.deliverReply("answer", "One")).rejects.toThrow("admission unavailable");
			await expect(service.deliverReply("answer", "One")).rejects.toThrow("model failed after append");
			await service.deliverReply("answer", "One");
			expect(attempts).toBe(2);
			expect(manager.getBranch().filter((entry) => entry.type === "custom_message")).toHaveLength(1);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("holds arriving prompts until asynchronous model configuration settles and releases after failure", async () => {
		const operations = createPiRuntimeOperationCoordinator({
			assertCanStart() {},
			getActiveReload: () => null,
			assertCanRunSynchronously() {},
			onReleased() {},
		});
		const ready = Promise.withResolvers<void>();
		const order: string[] = [];
		const mutation = operations.runOrderedMutation(async () => {
			order.push("configuring");
			await ready.promise;
			order.push("configured");
		});
		const prompt = operations.runPrompt(async () => {
			order.push("prompt");
		});
		await Promise.resolve();
		expect(order).not.toContain("prompt");
		ready.resolve();
		await Promise.all([mutation, prompt]);
		expect(order).toEqual(["configuring", "configured", "prompt"]);
		const failed = operations.runOrderedMutation(() => {
			throw new Error("configuration failed");
		});
		const after = operations.runPrompt(async () => {
			order.push("after failure");
		});
		await expect(failed).rejects.toThrow("configuration failed");
		await after;
		expect(operations.activeCount).toBe(0);
		expect(operations.pendingMutationCount).toBe(0);
	});
});
