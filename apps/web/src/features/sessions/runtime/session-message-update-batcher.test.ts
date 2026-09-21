import type { SessionEventEnvelope } from "@ling/contracts/session";
import { describe, expect, it, vi } from "vitest";
import { createSessionMessageUpdateBatcher } from "./session-message-update-batcher";

function update(id: string, sequence: number): SessionEventEnvelope {
	return {
		protocolVersion: 1,
		stateRevision: 1,
		runtimeId: "runtime",
		generation: 1,
		sequence,
		transcriptRevision: 1,
		ref: { cwd: "/project", sessionId: "session" },
		occurredAt: sequence,
		deliveryClass: "snapshotRecoverable",
		event: {
			type: "messageUpdate",
			message: { role: "user", id, entryId: null, occurredAt: sequence, content: `text ${sequence}` },
		},
	};
}

function setup() {
	const frames = new Set<() => void>();
	const onFlush = vi.fn();
	const batcher = createSessionMessageUpdateBatcher({
		onFlush,
		schedule(callback) {
			frames.add(callback);
			return () => {
				frames.delete(callback);
			};
		},
	});
	return {
		batcher,
		onFlush,
		frames,
		render() {
			const pending = [...frames];
			frames.clear();
			for (const callback of pending) callback();
		},
	};
}

describe("message update batching", () => {
	it("preserves dependent deltas and discards them only when a full frame supersedes the same message", () => {
		const { batcher, onFlush, render } = setup();
		const append = (sequence: number): SessionEventEnvelope => ({
			...update("a", sequence),
			event: {
				type: "messageDelta",
				messageId: "a",
				occurredAt: sequence,
				changes: [{ part: 0, kind: "text", offset: sequence, append: "x" }],
			},
		});
		batcher.enqueue("one", update("a", 1));
		batcher.enqueue("one", append(2));
		batcher.enqueue("one", append(3));
		render();
		expect(onFlush.mock.calls[0]?.[1]).toEqual([update("a", 1), append(2), append(3)]);
		batcher.enqueue("one", append(4));
		batcher.enqueue("one", update("b", 5));
		batcher.enqueue("one", append(6));
		batcher.enqueue("one", update("a", 7));
		render();
		expect(onFlush.mock.calls[1]?.[1]).toEqual([update("a", 7), update("b", 5)]);
		batcher.dispose();
	});
	it("keeps the latest revision per identity, independently for each session", () => {
		const { batcher, onFlush, render, frames } = setup();
		batcher.enqueue("one", update("a", 1));
		batcher.enqueue("one", update("b", 2));
		batcher.enqueue("one", update("a", 3));
		batcher.enqueue("two", update("a", 4));
		expect(frames.size).toBe(1);
		render();
		expect(onFlush.mock.calls).toEqual([
			["one", [update("a", 3), update("b", 2)]],
			["two", [update("a", 4)]],
		]);
		batcher.dispose();
	});

	it("flushes explicit ordering boundaries and cancels discarded work", () => {
		const { batcher, onFlush, frames, render } = setup();
		batcher.enqueue("one", update("a", 1));
		batcher.enqueue("two", update("a", 2));
		batcher.flush("one");
		batcher.discard("two");
		expect(frames.size).toBe(0);
		render();
		expect(onFlush).toHaveBeenCalledExactlyOnceWith("one", [update("a", 1)]);
		batcher.dispose();
	});

	it("bounds a throttled frame and releases scheduled callbacks at disposal", () => {
		const { batcher, onFlush, frames } = setup();
		// One beyond the per-session backlog must synchronously flush the previous batch.
		for (let index = 0; index < 257; index++) batcher.enqueue("one", update(`id-${index}`, index));
		expect(onFlush).toHaveBeenCalledTimes(1);
		expect(onFlush.mock.calls[0]?.[1]).toHaveLength(256);
		batcher.dispose();
		expect(frames.size).toBe(0);
		expect(() => batcher.enqueue("one", update("late", 999))).toThrow("disposed");
	});
});
