import {
	deserializeHostFrame,
	HOST_PROTOCOL_FRAME_MAX_BYTES,
	HOST_PROTOCOL_VERSION,
	parseHostClientFrame,
	serializeHostFrame,
	type HostClientFrame,
	type HostServerFrame,
} from "@ling/contracts/protocol/host-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectHostWebSocket, type HostWebSocketConnection } from "./host-websocket-transport";

const sockets: TestSocket[] = [];
const owners: HostWebSocketConnection[] = [];
class TestSocket extends EventTarget {
	static OPEN = 1;
	readyState = 0;
	binaryType = "blob";
	frames: HostClientFrame[] = [];
	constructor() {
		super();
		sockets.push(this);
		queueMicrotask(() => {
			this.readyState = 1;
			this.dispatchEvent(new Event("open"));
		});
	}
	send(data: string): void {
		this.frames.push(parseHostClientFrame(deserializeHostFrame(data)));
	}
	close(): void {
		if (this.readyState === 3) return;
		this.readyState = 3;
		this.dispatchEvent(Object.assign(new Event("close"), { code: 1006, reason: "Disconnected" }));
	}
	receive(frame: HostServerFrame): void {
		this.dispatchEvent(new MessageEvent("message", { data: serializeHostFrame(frame) }));
	}
}
const welcome = (hostId = "host", resume: "fresh" | "resumed" | "reload-required" = "fresh"): HostServerFrame => ({
	kind: "welcome",
	protocolVersion: HOST_PROTOCOL_VERSION,
	hostId,
	eventSequence: 0,
	resume,
	environment: { appVersion: "0.1.0", home: null, platform: "linux" },
});
const options = () => ({
	url: "ws://127.0.0.1:12345",
	token: "test-token",
	clientId: "client",
	product: "web" as const,
	onProtocolError: vi.fn(),
	onReloadRequired: vi.fn(),
});
function lastSocket(): TestSocket {
	const socket = sockets.at(-1);
	if (!socket) throw new Error("Socket missing");
	return socket;
}
beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal("WebSocket", TestSocket);
});
afterEach(() => {
	for (const owner of owners.splice(0)) owner.dispose();
	sockets.length = 0;
	vi.useRealTimers();
});
async function connect() {
	const config = options(),
		ready = connectHostWebSocket(config);
	await vi.advanceTimersByTimeAsync(0);
	lastSocket().receive(welcome());
	const owner = await ready;
	owners.push(owner);
	return { owner, config };
}

describe("authenticated reconnect ownership", () => {
	it("rejects oversized UTF-8 input before admission, including while disconnected", async () => {
		const { owner, config } = await connect();
		// Every character is three UTF-8 bytes, so character-count checks alone accept this.
		const text = "界".repeat(Math.floor(HOST_PROTOCOL_FRAME_MAX_BYTES / 3) + 1);
		await expect(owner.transport.invoke("session:sendMessage", [text])).rejects.toMatchObject({
			code: "INVALID_REQUEST",
			lingError: { details: { resource: "hostFrame" } },
		});
		expect(lastSocket().frames).toHaveLength(1);
		lastSocket().close();
		await expect(owner.transport.invoke("session:sendMessage", [text])).rejects.toMatchObject({
			code: "INVALID_REQUEST",
		});
		await vi.advanceTimersByTimeAsync(100);
		const resumed = lastSocket();
		expect(resumed.frames).toEqual([expect.objectContaining({ kind: "hello", pendingRequestIds: [] })]);
		resumed.receive(welcome("host", "resumed"));
		expect(resumed.frames).toHaveLength(1);
		expect(config.onProtocolError).not.toHaveBeenCalled();
	});

	it("waits for welcome before replaying exact request ids and acknowledging their responses", async () => {
		const { owner } = await connect(),
			first = lastSocket();
		const result = owner.transport.invoke("session:list", []);
		const request = first.frames.find((f) => f.kind === "request");
		if (!request) throw new Error("Request missing");
		first.close();
		await vi.advanceTimersByTimeAsync(100);
		const resumed = lastSocket();
		expect(resumed).not.toBe(first);
		expect(resumed.frames).toEqual([
			expect.objectContaining({ kind: "hello", lastEventSequence: 0, pendingRequestIds: [request.id] }),
		]);
		const secondResult = owner.transport.invoke("project:list", []);
		expect(resumed.frames).toHaveLength(1);
		resumed.receive(welcome("host", "resumed"));
		expect(resumed.frames[1]).toEqual(request);
		resumed.receive({ kind: "response", id: request.id, ok: true, result: ["resumed"] });
		expect(await result).toEqual(["resumed"]);
		const second = resumed.frames.find((f) => f.kind === "request" && f.method === "project:list");
		if (!second || second.kind !== "request") throw new Error("Second request missing");
		resumed.receive({ kind: "response", id: second.id, ok: true, result: [] });
		await secondResult;
		expect(resumed.frames).toContainEqual({ kind: "ack", eventSequence: 0, requestIds: [request.id] });
	});
	it.each(["changed-host", "reload-required"])(
		"stops pending requests on %s without replaying mutations",
		async (reason) => {
			const { owner, config } = await connect();
			const result = owner.transport.invoke("plugins:install", []),
				rejected = expect(result).rejects.toThrow();
			lastSocket().close();
			await vi.advanceTimersByTimeAsync(100);
			const resumed = lastSocket();
			resumed.receive(reason === "changed-host" ? welcome("other", "resumed") : welcome("host", "reload-required"));
			await rejected;
			expect(resumed.frames).toHaveLength(1);
			expect(config.onProtocolError).toHaveBeenCalledTimes(reason === "changed-host" ? 1 : 0);
			expect(config.onReloadRequired).toHaveBeenCalledTimes(reason === "reload-required" ? 1 : 0);
			const count = sockets.length;
			await vi.advanceTimersByTimeAsync(10000);
			expect(sockets).toHaveLength(count);
		},
	);
	it("fails an unanswered initial handshake and retires its connection", async () => {
		const ready = connectHostWebSocket(options()),
			rejected = expect(ready).rejects.toThrow("welcome timed out");
		await vi.advanceTimersByTimeAsync(10000);
		await rejected;
		expect(lastSocket().readyState).toBe(3);
	});
	it("settles pending calls with an Error when native errors exhaust reconnect attempts", async () => {
		const { owner, config } = await connect();
		const pending = owner.transport.invoke("session:list", []);
		const rejected = expect(pending).rejects.toThrow("Ling host WebSocket connection failed");
		for (let attempt = 0; attempt < 10; attempt += 1) {
			lastSocket().dispatchEvent(new Event("error"));
			await vi.advanceTimersByTimeAsync(5_000);
		}
		await rejected;
		expect(config.onProtocolError).toHaveBeenCalledWith(expect.any(Error));
		expect(config.onProtocolError).toHaveBeenCalledTimes(1);
	});
});
