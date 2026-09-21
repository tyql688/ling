import type { PiWorkerControlFrame, PiWorkerRequest } from "@ling/core/pi-protocol/protocol";
import { PI_WORKER_PROTOCOL_VERSION, PI_WORKER_REQUEST_CAPACITY } from "@ling/core/pi-protocol/wire-format";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPiWorkerRequestTransport } from "./pi-worker-request-transport";
import { createPiWorkerDomainClient } from "./pi-worker-domain-client";

function setup() {
	const frames: PiWorkerControlFrame[] = [];
	const first = {
		generation: 1,
		port: {
			postMessage: (frame: PiWorkerControlFrame) => {
				frames.push(frame);
			},
		},
	};
	const second = { generation: 2, port: first.port };
	let current = first;
	const failHost = vi.fn((host: typeof first, error: Error) => {
		transport.rejectHost(host, error);
	});
	const failHostGracefully = vi.fn();
	const transport = createPiWorkerRequestTransport({
		creationContexts: new Map(),
		ensureHost: () => Promise.resolve(current),
		failHost,
		failHostGracefully,
	});
	const requests = (): PiWorkerRequest[] =>
		frames.filter((frame): frame is PiWorkerRequest => frame.kind === "request");
	const reply = (request: PiWorkerRequest, result: unknown, host = current) =>
		transport.settleResponse(host, {
			kind: "result",
			protocolVersion: PI_WORKER_PROTOCOL_VERSION,
			generation: host.generation,
			requestId: request.requestId,
			method: request.method,
			result,
		});
	return {
		transport,
		first,
		second,
		frames,
		failHost,
		failHostGracefully,
		requests,
		reply,
		replace() {
			current = second;
		},
	};
}

// Admission crosses Host readiness before allocating an id.
const admitted = () => vi.advanceTimersByTimeAsync(0);
beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

describe("Pi request transport", () => {
	it("does not dispatch a login cancelled during project admission", async () => {
		const h = setup();
		const client = createPiWorkerDomainClient(h.transport.call);
		const cwd = "/tmp/ling-login-admission";
		const opening = client.openProject(cwd);
		await admitted();
		h.reply(h.requests()[0]!, { cwd, diagnostics: [] });
		await opening;
		const admission = new AbortController();
		const login = client.startLogin("cancel-before-start", "anthropic", "api_key", cwd, admission.signal);
		const rejected = expect(login).rejects.toThrow("cancelled");
		admission.abort(new Error("cancelled"));
		const cancelling = client.cancelLogin("cancel-before-start");
		await rejected;
		await admitted();
		expect(h.requests().some((request) => request.method === "model.loginStart")).toBe(false);
		const cancel = h.requests().find((request) => request.method === "model.loginCancel");
		expect(cancel).toBeDefined();
		h.reply(cancel!, null);
		await cancelling;
		expect(h.transport.pendingRequests(h.first).length > 0).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("keeps an admitted login's terminal response observable when cancellation arrives", async () => {
		const h = setup();
		const client = createPiWorkerDomainClient(h.transport.call);
		const admission = new AbortController();
		const login = client.startLogin("cancel-after-start", "anthropic", "api_key", null, admission.signal);
		await admitted();
		const start = h.requests()[0]!;
		expect(start.method).toBe("model.loginStart");
		admission.abort();
		const cancelling = client.cancelLogin("cancel-after-start");
		await admitted();
		h.reply(h.requests()[1]!, null);
		await cancelling;
		expect(h.transport.pendingRequests(h.first).length > 0).toBe(true);
		h.reply(start, null);
		await expect(login).resolves.toBeUndefined();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("matches concurrent ids and ignores stale generations", async () => {
		const h = setup();
		const one = h.transport.call("settings.getProxy", {});
		const two = h.transport.call("settings.getProxy", {});
		await admitted();
		const [first, second] = h.requests();
		if (!first || !second) throw new Error("Missing requests");
		expect(first.requestId).not.toBe(second.requestId);
		h.reply(first, "http://stale", h.second);
		expect(h.transport.pendingRequests(h.first).length > 0).toBe(true);
		h.reply(second, null);
		h.reply(first, "http://proxy");
		await expect(one).resolves.toBe("http://proxy");
		await expect(two).resolves.toBeNull();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("cancels pending work once and releases timers and abort listeners", async () => {
		const h = setup();
		const controller = new AbortController();
		const remove = vi.spyOn(controller.signal, "removeEventListener");
		const work = h.transport.call("settings.getProxy", {}, { signal: controller.signal });
		const rejected = expect(work).rejects.toThrow("cancelled by owner");
		await admitted();
		controller.abort(new Error("cancelled by owner"));
		await rejected;
		expect(h.frames.filter((frame) => frame.kind === "cancel")).toHaveLength(1);
		expect(h.transport.pendingRequests(h.first).length > 0).toBe(false);
		expect(remove).toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("times out commands and asks the supervisor to retire their generation", async () => {
		const h = setup();
		const work = h.transport.call(
			"runtime.abort",
			{ runtimeId: "test-runtime", ref: { cwd: process.cwd(), sessionId: "test-session" } },
			{ timeoutMs: 20 },
		);
		const rejected = expect(work).rejects.toThrow("timed out");
		await vi.advanceTimersByTimeAsync(20);
		await rejected;
		expect(h.frames.at(-1)).toMatchObject({ kind: "cancel" });
		expect(h.failHostGracefully).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("retries a reconstructible query once after generation loss, never a command", async () => {
		const h = setup();
		const query = h.transport.call("settings.getProxy", {});
		const command = h.transport.call("runtime.abort", {
			runtimeId: "test-runtime",
			ref: { cwd: process.cwd(), sessionId: "test-session" },
		});
		const commandRejected = expect(command).rejects.toThrow("host gone");
		await admitted();
		h.replace();
		h.transport.rejectHost(h.first, new Error("host gone"));
		await commandRejected;
		await admitted();
		const retry = h.requests().at(-1);
		if (!retry) throw new Error("Missing retry");
		expect(h.requests().map((request) => request.method)).toEqual([
			"settings.getProxy",
			"runtime.abort",
			"settings.getProxy",
		]);
		expect(retry.generation).toBe(2);
		h.reply(retry, null);
		await expect(query).resolves.toBeNull();
	});

	it("isolates malformed query results and rejects malformed command results through the supervisor", async () => {
		const h = setup();
		const query = h.transport.call("settings.getProxy", {});
		const rejectedQuery = expect(query).rejects.toThrow("invalid result");
		await admitted();
		h.reply(h.requests()[0]!, 42);
		await rejectedQuery;
		expect(h.failHost).not.toHaveBeenCalled();
		const command = h.transport.call("runtime.abort", {
			runtimeId: "test-runtime",
			ref: { cwd: process.cwd(), sessionId: "test-session" },
		});
		const rejectedCommand = expect(command).rejects.toThrow("invalid result");
		await admitted();
		h.reply(h.requests()[1]!, 42);
		await rejectedCommand;
		expect(h.failHost).toHaveBeenCalledTimes(1);
	});

	it("enforces admission capacity and rejects all requests for a lost host", async () => {
		const h = setup();
		const requests = Array.from({ length: PI_WORKER_REQUEST_CAPACITY }, () =>
			h.transport.call("runtime.abort", {
				runtimeId: "test-runtime",
				ref: { cwd: process.cwd(), sessionId: "test-session" },
			}),
		);
		const settlements = Promise.allSettled(requests);
		await admitted();
		await expect(
			h.transport.call("runtime.abort", {
				runtimeId: "test-runtime",
				ref: { cwd: process.cwd(), sessionId: "test-session" },
			}),
		).rejects.toMatchObject({ code: "REQUEST_CAPACITY_EXCEEDED" });
		expect(h.frames).toHaveLength(PI_WORKER_REQUEST_CAPACITY);
		h.transport.rejectHost(h.first, new Error("disposed"));
		expect((await settlements).every((result) => result.status === "rejected")).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});
});
