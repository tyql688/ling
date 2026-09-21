import { expect, it, vi } from "vitest";
import type { PiAgentSessionRuntime } from "../types";
import { createPiRuntimeCommands } from "./runtime-commands";
import { createPiRuntimeOperationCoordinator } from "./runtime-operations";

it.each([false, true])(
	"retries after queued model changes without waiting on itself, and drains on failure=%s",
	async (fails) => {
		const operations = createPiRuntimeOperationCoordinator({
			assertCanStart: () => undefined,
			getActiveReload: () => null,
			assertCanRunSynchronously: () => undefined,
			onReleased: () => undefined,
		});
		const modelChange = Promise.withResolvers<void>();
		const modelChanged = operations.runOrderedMutation(() => modelChange.promise);
		const completion = Promise.withResolvers<void>();
		const order: string[] = [];
		const prompt = vi.fn(() => {
			order.push("prompt");
			return completion.promise;
		});
		const user = { type: "message", id: "user", message: { role: "user", content: "Retry this" } };
		const runtime = {
			session: {
				isIdle: true,
				sessionManager: {
					getBranch: () => [
						user,
						{ type: "message", id: "failed", message: { role: "assistant", stopReason: "error" } },
					],
					getLeafId: () => "failed",
					getEntry: () => user,
				},
				prompt,
			},
		} as unknown as PiAgentSessionRuntime;
		const commands = createPiRuntimeCommands({
			runtime: () => runtime,
			operations,
			isActive: () => true,
			emitSnapshotChanged: () => undefined,
			projectModelState: () => {
				throw new Error("Unused by retry");
			},
			sessionActions: {
				navigateTree: async () => {
					order.push("rewind");
					return { cancelled: false };
				},
			} as unknown as Parameters<typeof createPiRuntimeCommands>[0]["sessionActions"],
		});
		const result = commands.retryTurn("user").then(
			() => "completed",
			() => "failed",
		);
		expect(prompt).not.toHaveBeenCalled();
		modelChange.resolve();
		await modelChanged;
		await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce());
		expect(order).toEqual(["rewind", "prompt"]);
		expect(prompt).toHaveBeenCalledWith("Retry this", {
			source: "interactive",
			images: [],
			expandPromptTemplates: false,
		});
		expect(operations.activePromptCount).toBe(1);
		expect(operations.pendingMutationCount).toBe(0);
		await operations.runPrompt(async () => order.push("answer"));
		expect(order).toEqual(["rewind", "prompt", "answer"]);
		if (fails) completion.reject(new Error("Provider failed"));
		else completion.resolve();
		expect(await result).toBe(fails ? "failed" : "completed");
		expect(operations.activeCount).toBe(0);
		expect(operations.pendingMutationCount).toBe(0);
		expect(operations.captureDrains()).toEqual({ runtimeMutations: null, runtimeOperations: null });
	},
);
