import { temporaryDirectory } from "../../../../../test/temporary-directory";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTurnFileTracker } from "./turn-file-tracker";

let directory: string;
beforeEach(async () => {
	directory = await temporaryDirectory("turn-test");
});
afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});
const call = (
	toolCallId: string,
	path = "file.txt",
): Parameters<ReturnType<typeof createTurnFileTracker>["handleToolCall"]>[0] => ({
	type: "tool_call",
	toolName: "write",
	toolCallId,
	input: { path, content: "after" },
});

describe("turn file capture bounds", () => {
	it("bounds repeated pending calls even when they all target one file", async () => {
		const event = vi.fn();
		const tracker = createTurnFileTracker(directory, event);
		await writeFile(join(directory, "file.txt"), "before");
		await tracker.startRun();
		// Path count remains one; the independent pending-call limit still protects memory.
		for (let index = 0; index < 513; index++) await tracker.handleToolCall(call(`call-${index}`));
		expect((await tracker.finishRun()).failureCode).toBe("TURN_LIMIT_EXCEEDED");
		expect(event).toHaveBeenCalledExactlyOnceWith({ type: "changeReviewTrackingFailed", code: "TURN_LIMIT_EXCEEDED" });
		tracker.dispose();
	});

	it("bounds an event burst before filesystem work can drain", async () => {
		const tracker = createTurnFileTracker(directory, () => undefined);
		await tracker.startRun();
		const operations = Array.from({ length: 1041 }, (_, index) => tracker.handleToolCall(call(`call-${index}`)));
		await Promise.all(operations);
		expect((await tracker.finishRun()).failureCode).toBe("TURN_LIMIT_EXCEEDED");
		tracker.dispose();
	});

	it("ignores paths outside the project and fences results after disposal", async () => {
		const event = vi.fn();
		const tracker = createTurnFileTracker(directory, event);
		await tracker.startRun();
		await tracker.handleToolCall(call("escape", "../outside.txt"));
		expect(await tracker.finishRun()).toEqual({ files: [], failureCode: null });
		await tracker.startRun();
		tracker.dispose();
		await tracker.handleToolCall(call("late"));
		expect(await tracker.finishRun()).toEqual({ files: [], failureCode: "CAPTURE_FAILED" });
		expect(event).not.toHaveBeenCalled();
	});
});
