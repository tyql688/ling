import type { SessionRuntimeEvent } from "@ling/core/pi-protocol/runtime-types";
import type { AssistantSessionMessage } from "@ling/contracts/session-messages";
import { applySessionMessageDelta } from "@ling/contracts/session-message-delta";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPiWorkerRuntimeEventDelivery, type PiWorkerEventPayload } from "./pi-worker-runtime-events";

const update = (id: string, text: string): SessionRuntimeEvent => ({
	type: "messageUpdate",
	message: { role: "user", id, entryId: null, occurredAt: 1, content: text },
});
function setup() {
	let disposed = false;
	const events: PiWorkerEventPayload[] = [];
	const fatal = vi.fn();
	const delivery = createPiWorkerRuntimeEventDelivery({
		runtimeId: "runtime",
		runtime: { isBusy: () => true },
		buildState: () => {
			throw new Error("Unexpected full snapshot");
		},
		emit: (event) => {
			events.push(event);
		},
		isDisposed: () => disposed,
		onFatal: fatal,
	});
	return {
		delivery,
		events,
		fatal,
		dispose() {
			disposed = true;
			delivery.discardPendingMessageUpdate();
		},
	};
}

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

describe("Pi runtime event delivery", () => {
	it("reconstructs Unicode text and thinking deltas and realigns at snapshot and transformer boundaries", async () => {
		const h = setup();
		const first: AssistantSessionMessage = {
			role: "assistant",
			id: "assistant",
			entryId: null,
			occurredAt: 1,
			content: [
				{ type: "thinking", thinking: "想" },
				{ type: "text", text: "中文" },
			],
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
		};
		const next: AssistantSessionMessage = {
			...first,
			occurredAt: 2,
			content: [
				{ type: "thinking", thinking: "想好了" },
				{ type: "text", text: "中文😀\ncode" },
			],
		};
		h.delivery.deliver({ type: "messageStart", message: first });
		h.delivery.deliver({ type: "messageUpdate", message: next });
		await h.delivery.waitForDelivery();
		const delta = h.events.filter((event) => event.kind === "runtimeEvent").at(-1)?.event;
		if (delta?.type !== "messageDelta") throw new Error("Missing assistant delta");
		expect(applySessionMessageDelta(first, delta)).toEqual(next);
		await h.delivery.capture(() => Promise.resolve(next));
		h.delivery.deliver({ type: "messageUpdate", message: next });
		await h.delivery.waitForDelivery();
		expect(h.events.at(-1)).toMatchObject({ kind: "runtimeEvent", event: { type: "messageUpdate", message: next } });
		h.delivery.deliver({ type: "messageUpdate", message: next, streamMode: "full" });
		await h.delivery.waitForDelivery();
		expect(h.events.at(-1)).toMatchObject({
			kind: "runtimeEvent",
			event: { type: "messageUpdate", streamMode: "full" },
		});
		h.delivery.deliver({ type: "messageEnd", message: next });
		await h.delivery.waitForDelivery();
		expect(h.events.at(-1)).toMatchObject({ kind: "runtimeEvent", event: { type: "messageEnd", message: next } });
		h.dispose();
	});
	it("coalesces updates while preserving identity boundaries and sequence order", async () => {
		const h = setup();
		h.delivery.deliver(update("one", "old"));
		h.delivery.deliver(update("one", "new"));
		h.delivery.deliver(update("two", "other"));
		await h.delivery.waitForDelivery();
		expect(h.events.map((event) => event.kind)).toEqual(["runtimeEvent", "runtimeBusy", "runtimeEvent"]);
		expect(h.events.map((event) => ("sequence" in event ? event.sequence : null))).toEqual([1, 2, 3]);
		expect(h.events.filter((event) => event.kind === "runtimeEvent").map((event) => event.event)).toEqual([
			update("one", "new"),
			update("two", "other"),
		]);
		h.dispose();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("flushes the pending projection before capturing a snapshot fence", async () => {
		const h = setup();
		h.delivery.deliver(update("one", "final"));
		const snapshot = await h.delivery.capture(() => Promise.resolve("snapshot"));
		expect(snapshot).toEqual({ result: "snapshot", eventSequence: 2 });
		expect(h.events).toHaveLength(2);
		h.dispose();
	});

	it("discards buffered work when the runtime is disposed", async () => {
		const h = setup();
		h.delivery.deliver(update("one", "late"));
		h.dispose();
		await vi.runAllTimersAsync();
		await h.delivery.waitForDelivery();
		expect(h.events).toEqual([]);
		expect(h.fatal).not.toHaveBeenCalled();
	});
});
