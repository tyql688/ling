import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkerRpc, postWorkerMessage } from "./worker-rpc";

const owners: Array<{ close(error: Error): void }> = [];
afterEach(() => {
	for (const owner of owners.splice(0)) owner.close(new Error("Test completed"));
	vi.useRealTimers();
});

function pair(handler: (request: unknown) => unknown = (value) => value) {
	let clientListener: ((value: unknown) => void) | null = null;
	let serverListener: ((value: unknown) => void) | null = null;
	const errors = vi.fn(),
		events = vi.fn();
	const frames: unknown[] = [];
	const client = createWorkerRpc<unknown, unknown, unknown, { owner: string }>({
		capacity: 2,
		capacityError: () => new Error("Full"),
		maxFrameBytes: 8_192,
		post(frame) {
			frames.push(frame);
			queueMicrotask(() => serverListener?.(frame));
		},
		onMessage(listener) {
			clientListener = listener;
			return () => {
				clientListener = null;
			};
		},
		receiveEvent: events,
		parseResponse: (value) => value,
		onError: errors,
	});
	const server = createWorkerRpc<never, unknown, unknown>({
		capacity: 2,
		capacityError: () => new Error("Full"),
		maxFrameBytes: 8_192,
		post(frame) {
			queueMicrotask(() => clientListener?.(frame));
		},
		onMessage(listener) {
			serverListener = listener;
			return () => {
				serverListener = null;
			};
		},
		receiveRequest: handler,
		parseResponse: (value) => value,
		onError: errors,
	});
	owners.push(client, server);
	return { client, server, errors, events, frames, receive: (frame: unknown) => clientListener?.(frame) };
}
const callOptions = () => ({ context: { owner: "test" }, deadline: null });

describe("worker RPC ownership", () => {
	it("waits for Node delivery callbacks and propagates asynchronous send failure", async () => {
		let delivered: ((error: Error | null) => void) | undefined;
		const send = vi.fn((_message, callback: (error: Error | null) => void) => {
			delivered = callback;
			return false;
		});
		const sent = postWorkerMessage({ send }, {});
		const rejected = expect(sent).rejects.toThrow("Delivery failed");
		delivered?.(new Error("Delivery failed"));
		await rejected;
		await expect(postWorkerMessage({}, {})).rejects.toThrow("unavailable");
	});
	it("dispatches validated frames, correlates out-of-order replies and delivers events", async () => {
		const deferred = Promise.withResolvers<unknown>();
		const p = pair((value) => (value === "slow" ? deferred.promise : value));
		const slow = p.client.call("slow", callOptions());
		expect(await p.client.call("fast", callOptions())).toBe("fast");
		deferred.resolve("finished");
		expect(await slow).toBe("finished");
		await p.server.emit({ progress: 1 });
		await Promise.resolve();
		expect(p.events).toHaveBeenCalledWith({ progress: 1 });
		expect(p.client.size).toBe(0);
	});
	it("bounds capacity, releases abort waits without sending cancellation frames and ignores late replies", async () => {
		const remote = Promise.withResolvers<unknown>(),
			p = pair(() => remote.promise),
			controller = new AbortController();
		const first = p.client.call("one", { ...callOptions(), signal: controller.signal });
		const second = p.client.call("two", callOptions());
		await expect(p.client.call("three", callOptions())).rejects.toThrow("Full");
		const aborted = expect(first).rejects.toThrow("Cancelled");
		controller.abort(new Error("Cancelled"));
		await aborted;
		expect(p.client.size).toBe(1);
		expect(p.frames).toHaveLength(2);
		remote.resolve("late");
		expect(await second).toBe("late");
		expect(p.client.size).toBe(0);
	});
	it("retires timers at deadline and on owner close", async () => {
		vi.useFakeTimers();
		const p = pair(() => new Promise(() => {}));
		const request = p.client.call("one", {
			...callOptions(),
			deadline: { at: Date.now() + 100, error: () => new Error("Expired") },
		});
		const rejected = expect(request).rejects.toThrow("Expired");
		await vi.advanceTimersByTimeAsync(100);
		await rejected;
		expect(p.client.size).toBe(0);
		const pending = p.client.call("two", callOptions());
		const closed = expect(pending).rejects.toThrow("Lost");
		p.client.close(new Error("Lost"));
		await closed;
		expect(vi.getTimerCount()).toBe(0);
	});
	it("surfaces remote errors and rejects forged methods before dispatch", async () => {
		const p = pair(() => {
			throw new Error("Remote failed");
		});
		await expect(p.client.call("one", callOptions())).rejects.toThrow("Remote failed");
		p.receive({ t: "q", m: "constructor", a: [{}] });
		expect(p.errors).toHaveBeenCalledOnce();
	});
	it("owns request and event send failures even when the error observer only logs", async () => {
		const errors = vi.fn();
		const makeOwner = () => {
			const owner = createWorkerRpc<unknown, unknown, unknown>({
				capacity: 1,
				capacityError: () => new Error("Full"),
				maxFrameBytes: 8_192,
				post() {
					throw new Error("Disconnected");
				},
				onMessage: () => () => {},
				parseResponse: (value) => value,
				onError: errors,
			});
			owners.push(owner);
			return owner;
		};
		const caller = makeOwner();
		await expect(caller.call({}, { context: undefined, deadline: null })).rejects.toThrow("Disconnected");
		expect(caller.size).toBe(0);
		await expect(caller.call({}, { context: undefined, deadline: null })).rejects.toThrow("closed");
		await expect(makeOwner().emit({})).rejects.toThrow("Disconnected");
		expect(errors).toHaveBeenCalledTimes(2);
	});
});
