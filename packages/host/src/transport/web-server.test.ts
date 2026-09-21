import { once } from "node:events";
import { rm } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import {
	deserializeHostFrame,
	HOST_PROTOCOL_VERSION,
	parseHostServerFrame,
	serializeHostFrame,
	type HostServerFrame,
} from "@ling/contracts/protocol/host-protocol";
import { temporaryDirectory } from "../../../../test/temporary-directory";
import { createHostEventBus } from "./event-bus";
import { createHostRequestRouter } from "./request-router";
import { startHostWebServer } from "./web-server";

describe("browser client lifetime", () => {
	it("retains resources for transport reconnects and releases them before a fresh page is welcomed", async () => {
		const directory = await temporaryDirectory("client-lifetime");
		const disconnected: string[] = [];
		const sockets: WebSocket[] = [];
		try {
			const server = await startHostWebServer({
				environment: { appVersion: "test", home: directory, platform: "linux" },
				events: createHostEventBus(),
				preferredPort: null,
				router: createHostRequestRouter(),
				staticDirectory: directory,
				serveMedia: async (_request, response) => {
					response.writeHead(404).end();
				},
				onClientDisconnected: (clientId) => disconnected.push(clientId),
			});
			try {
				async function connect(lastEventSequence: number | null) {
					const socket = new WebSocket(`${server.origin.replace("http:", "ws:")}/api/ws`, {
						origin: server.origin,
					});
					sockets.push(socket);
					await once(socket, "open");
					const welcome = once(socket, "message");
					socket.send(
						serializeHostFrame({
							kind: "hello",
							protocolVersion: HOST_PROTOCOL_VERSION,
							token: server.token,
							clientId: "tab",
							product: "web",
							lastEventSequence,
							pendingRequestIds: [],
						}),
					);
					const [data] = await welcome;
					const frame = parseHostServerFrame(JSON.parse(String(data)));
					expect(frame).toMatchObject({ kind: "welcome", resume: lastEventSequence === null ? "fresh" : "resumed" });
					return socket;
				}
				const original = await connect(null);
				expect(disconnected).toEqual([]);
				const closed = once(original, "close");
				original.close();
				await closed;
				await connect(0);
				expect(disconnected).toEqual([]);
				await connect(null);
				expect(disconnected).toEqual(["tab"]);
			} finally {
				for (const socket of sockets) socket.terminate();
				await server.close();
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("fails a request whose result cannot be serialized and keeps serving the client", async () => {
		const directory = await temporaryDirectory("unserializable-result");
		const router = createHostRequestRouter();
		router.handle("test:bigint", async () => ({ size: 1n }));
		router.handle("test:text", async () => "served");
		const server = await startHostWebServer({
			environment: { appVersion: "test", home: directory, platform: "linux" },
			events: createHostEventBus(),
			preferredPort: null,
			router,
			staticDirectory: directory,
			serveMedia: async (_request, response) => {
				response.writeHead(404).end();
			},
			onClientDisconnected: () => undefined,
		});
		const socket = new WebSocket(`${server.origin.replace("http:", "ws:")}/api/ws`, { origin: server.origin });
		try {
			const frames: HostServerFrame[] = [];
			socket.on("message", (data: Buffer) =>
				frames.push(parseHostServerFrame(deserializeHostFrame(data.toString("utf8")))),
			);
			await once(socket, "open");
			const send = (frame: Parameters<typeof serializeHostFrame>[0]) => socket.send(serializeHostFrame(frame));
			send({
				kind: "hello",
				protocolVersion: HOST_PROTOCOL_VERSION,
				token: server.token,
				clientId: "tab",
				product: "web",
				lastEventSequence: null,
				pendingRequestIds: [],
			});
			send({ kind: "request", id: "bigint", method: "test:bigint", args: [] });
			send({ kind: "request", id: "text", method: "test:text", args: [] });
			await vi.waitFor(() => expect(frames).toHaveLength(3));
			// A settled request id repeated by a reconnecting client replays the stored failure.
			send({ kind: "request", id: "bigint", method: "test:bigint", args: [] });
			await vi.waitFor(() => expect(frames).toHaveLength(4));
			const responses = frames.filter((frame) => frame.kind === "response");
			expect(responses).toMatchObject([
				{ id: "bigint", ok: false },
				{ id: "text", ok: true, result: "served" },
				{ id: "bigint", ok: false },
			]);
		} finally {
			socket.terminate();
			await server.close();
			await rm(directory, { recursive: true, force: true });
		}
	});
});
