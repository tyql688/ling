import {
	deserializeHostFrame,
	HOST_PROTOCOL_FRAME_MAX_BYTES,
	HOST_PROTOCOL_PENDING_REQUEST_CAPACITY,
	HOST_PROTOCOL_VERSION,
	parseHostClientFrame,
	serializeHostFrame,
	type HostClientFrame,
	type HostEnvironment,
	type HostProtocolError,
	type HostServerFrame,
} from "@ling/contracts/protocol/host-protocol";
import { attemptCleanup, toError } from "@ling/core/ling-error";
import { createLogger } from "@ling/core/logger";
import { normalizeRequestError } from "@ling/host/transport/request-error";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { extname, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { HostEventBus } from "./event-bus";
import { requestFingerprint, type HostRequestRouter } from "./request-router";

export type HostMediaResponder = (request: IncomingMessage, response: ServerResponse) => Promise<void>;

const log = createLogger("host-web");
/** Maximum simultaneously authenticated clients; bounds event fan-out and per-client request caches. */
const HOST_CLIENT_CAPACITY = 32;
/** Maximum completed response records retained until acknowledgement for one client. */
const HOST_CLIENT_REPLAY_CAPACITY = 512;
/** Disconnected clients retain in-flight request identity for thirty seconds so a transport reconnect cannot duplicate work. */
const HOST_CLIENT_RECONNECT_GRACE_MS = 30_000;
/** Unauthenticated sockets have five seconds to send hello before they are dropped. */
const HOST_HELLO_TIMEOUT_MS = 5_000;
/** Graceful server close waits two seconds before any remaining socket is terminated. */
const HOST_CLOSE_TIMEOUT_MS = 2_000;
/** Browser media cookies expire after one day; reconnecting through a launch token rotates them. */
const HOST_HTTP_SESSION_MAX_AGE_SECONDS = 24 * 60 * 60;

interface ReplayRecord {
	fingerprint: string;
	/** The serialized response, resent verbatim when a reconnecting client repeats the request. */
	text: string;
}

interface ActiveRequestRecord {
	controller: AbortController;
	fingerprint: string;
}

interface ClientRecord {
	active: Map<string, ActiveRequestRecord>;
	disconnectTimer: ReturnType<typeof setTimeout> | null;
	product: "electron" | "web";
	replays: Map<string, ReplayRecord>;
	socket: WebSocket | null;
}

interface HostWebServerOptions {
	environment: HostEnvironment;
	events: HostEventBus;
	/** Reuses the previous loopback origin so origin-scoped renderer preferences survive Host restarts. */
	preferredPort: number | null;
	router: HostRequestRouter;
	staticDirectory: string;
	serveMedia: HostMediaResponder;
	/** Ends retained resources after disconnect expiry or replacement by a fresh browser lifetime. */
	onClientDisconnected?(clientId: string): void;
}

interface HostWebServer {
	hostId: string;
	origin: string;
	token: string;
	launchUrl: string;
	close(): Promise<void>;
}

function protocolFailure(code: HostProtocolError["code"], message: string): HostProtocolError {
	return { code, message };
}

function sendText(socket: WebSocket, text: string): void {
	if (socket.readyState === WebSocket.OPEN) socket.send(text);
}

function sendFrame(socket: WebSocket, frame: HostServerFrame): void {
	sendText(socket, serializeHostFrame(frame));
}

function websocketText(data: RawData): string {
	if (Buffer.isBuffer(data)) return data.toString("utf8");
	if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
	return Buffer.concat(data).toString("utf8");
}

function tokenMatches(expected: string, received: string): boolean {
	const expectedDigest = createHash("sha256").update(expected).digest();
	const receivedDigest = createHash("sha256").update(received).digest();
	return timingSafeEqual(expectedDigest, receivedDigest);
}

function bearerToken(request: IncomingMessage): string | null {
	const authorization = request.headers.authorization;
	return authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : null;
}

function cookieValue(request: IncomingMessage, name: string): string | null {
	for (const segment of (request.headers.cookie ?? "").split(";")) {
		const separator = segment.indexOf("=");
		if (separator < 0 || segment.slice(0, separator).trim() !== name) continue;
		return segment.slice(separator + 1).trim();
	}
	return null;
}

function contentType(path: string): string {
	switch (extname(path)) {
		case ".css":
			return "text/css; charset=utf-8";
		case ".html":
			return "text/html; charset=utf-8";
		case ".js":
		case ".mjs":
			return "text/javascript; charset=utf-8";
		case ".json":
			return "application/json; charset=utf-8";
		case ".svg":
			return "image/svg+xml";
		case ".webm":
			return "video/webm";
		case ".webp":
			return "image/webp";
		case ".png":
			return "image/png";
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".gif":
			return "image/gif";
		case ".avif":
			return "image/avif";
		case ".ico":
			return "image/vnd.microsoft.icon";
		case ".woff":
			return "font/woff";
		case ".woff2":
			return "font/woff2";
		case ".ttf":
			return "font/ttf";
		case ".otf":
			return "font/otf";
		default:
			return "application/octet-stream";
	}
}

async function serveStatic(root: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
	if (request.method !== "GET" && request.method !== "HEAD") {
		response.writeHead(405, { Allow: "GET, HEAD" }).end();
		return;
	}
	const url = new URL(request.url ?? "/", "http://ling.local");
	let relativePath: string;
	try {
		relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, "");
	} catch {
		response.writeHead(400).end();
		return;
	}
	const requested = resolve(root, relativePath.length === 0 ? "index.html" : relativePath);
	if (requested !== root && !requested.startsWith(`${root}${sep}`)) {
		response.writeHead(404).end();
		return;
	}
	let metadata: Awaited<ReturnType<typeof stat>>;
	try {
		metadata = await stat(requested);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			response.writeHead(404).end();
			return;
		}
		throw error;
	}
	if (!metadata.isFile()) {
		response.writeHead(404).end();
		return;
	}
	// Vite emits eight-character content hashes under assets/. Only those URLs can
	// stay fresh for a year (31,536,000 seconds); public files must revalidate after upgrades.
	const contentHashed = /^assets\/.+-[A-Za-z0-9_-]{8}\.[^/.]+$/.test(relativePath);
	response.writeHead(200, {
		"Cache-Control": requested.endsWith("index.html")
			? "no-store"
			: contentHashed
				? "public, max-age=31536000, immutable"
				: "no-cache",
		"Content-Length": metadata.size,
		"Content-Type": contentType(requested),
		"Cross-Origin-Opener-Policy": "same-origin",
		"Referrer-Policy": "no-referrer",
		"X-Content-Type-Options": "nosniff",
	});
	if (request.method === "HEAD") {
		response.end();
		return;
	}
	await pipeline(createReadStream(requested), response);
}

/** A result the wire cannot carry fails its own request; it must not reject past the dispatch chain. */
function serializeResponse(method: string, response: Extract<HostServerFrame, { kind: "response" }>): string {
	try {
		return serializeHostFrame(response);
	} catch (error) {
		log.error(`Host response for ${method} could not be serialized:`, error);
		return serializeHostFrame(errorResponse(response.id, error));
	}
}

function errorResponse(id: string, error: unknown): Extract<HostServerFrame, { kind: "response" }> {
	const candidate = typeof error === "object" && error !== null ? (error as { code?: unknown; message?: unknown }) : {};
	if (candidate.code === "UNKNOWN_METHOD") {
		return {
			kind: "response",
			id,
			ok: false,
			error: { kind: "protocol", error: protocolFailure("UNKNOWN_METHOD", String(candidate.message)) },
		};
	}
	return {
		kind: "response",
		id,
		ok: false,
		error: {
			kind: "domain",
			error: normalizeRequestError(error, { fallbackMessage: "Ling host request failed" }),
		},
	};
}

function listenOnLoopback(server: ReturnType<typeof createServer>, port: number): Promise<void> {
	return new Promise<void>((resolveListening, rejectListening) => {
		const onError = (error: Error): void => {
			server.off("listening", onListening);
			rejectListening(error);
		};
		const onListening = (): void => {
			server.off("error", onError);
			resolveListening();
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(port, "127.0.0.1");
	});
}

export async function startHostWebServer(options: HostWebServerOptions): Promise<HostWebServer> {
	const staticDirectory = resolve(options.staticDirectory);
	const token = randomBytes(32).toString("base64url");
	const hostId = randomUUID();
	const clients = new Map<string, ClientRecord>();
	const httpSessions = new Map<string, number>();
	const sockets = new Set<WebSocket>();
	const connections = new Set<Socket>();
	let closing: Promise<void> | null = null;
	let expectedOrigin = "";
	const expireHttpSessions = (): void => {
		const oldestAllowed = Date.now() - HOST_HTTP_SESSION_MAX_AGE_SECONDS * 1_000;
		for (const [sessionId, issuedAt] of httpSessions) {
			if (issuedAt >= oldestAllowed) continue;
			httpSessions.delete(sessionId);
		}
	};
	const server = createServer((request, response) => {
		const route = async (): Promise<void> => {
			const url = new URL(request.url ?? "/", "http://ling.local");
			if (url.pathname === "/api/auth") {
				expireHttpSessions();
				const received = bearerToken(request);
				if (
					request.method !== "POST" ||
					request.headers.origin !== expectedOrigin ||
					!received ||
					!tokenMatches(token, received)
				) {
					response.writeHead(403).end();
					return;
				}
				const sessionId = randomBytes(32).toString("base64url");
				httpSessions.set(sessionId, Date.now());
				while (httpSessions.size > HOST_CLIENT_CAPACITY)
					httpSessions.delete(httpSessions.keys().next().value as string);
				response
					.writeHead(204, {
						"Cache-Control": "no-store",
						"Set-Cookie": `ling_host_session=${sessionId}; HttpOnly; SameSite=Strict; Path=/api/media; Max-Age=${HOST_HTTP_SESSION_MAX_AGE_SECONDS}`,
					})
					.end();
				return;
			}
			if (url.pathname.startsWith("/api/media/")) {
				expireHttpSessions();
				const sessionId = cookieValue(request, "ling_host_session");
				if (sessionId === null || !httpSessions.has(sessionId)) {
					response.writeHead(401).end();
					return;
				}
				await options.serveMedia(request, response);
				return;
			}
			await serveStatic(staticDirectory, request, response);
		};
		void route().catch((error: unknown) => {
			log.error("Static response failed:", error);
			if (!response.headersSent) response.writeHead(500);
			response.end();
		});
	});
	const webSockets = new WebSocketServer({ noServer: true, maxPayload: HOST_PROTOCOL_FRAME_MAX_BYTES });
	server.on("connection", (connection) => {
		connections.add(connection);
		connection.once("close", () => connections.delete(connection));
	});

	server.on("upgrade", (request, socket, head) => {
		if (closing) {
			socket.destroy();
			return;
		}
		let pathname: string | null = null;
		try {
			pathname = new URL(request.url ?? "/", expectedOrigin).pathname;
		} catch {
			pathname = null;
		}
		if (pathname !== "/api/ws" || request.headers.origin !== expectedOrigin) {
			log.warn(
				`Rejected WebSocket upgrade pathMatch=${String(pathname === "/api/ws")} originMatch=${String(request.headers.origin === expectedOrigin)}`,
			);
			socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
			socket.destroy();
			return;
		}
		webSockets.handleUpgrade(request, socket, head, (webSocket) => webSockets.emit("connection", webSocket, request));
	});

	webSockets.on("connection", (socket) => {
		sockets.add(socket);
		// ws closes malformed/oversized peers itself, then emits error. Observe it so one
		// rejected peer cannot become an uncaught EventEmitter error in the Host process.
		socket.on("error", (error) => log.warn("Host WebSocket peer failed:", error));
		let clientId: string | null = null;
		let record: ClientRecord | null = null;
		let releaseEvents: (() => void) | null = null;
		const helloTimer = setTimeout(() => socket.close(1008, "hello required"), HOST_HELLO_TIMEOUT_MS);
		const fatal = (error: HostProtocolError): void => {
			log.warn(`Rejected Host WebSocket frame code=${error.code}`);
			sendFrame(socket, { kind: "fatal", error });
			socket.close(1008, error.code);
		};
		socket.on("message", (data, isBinary) => {
			// A replaced connection can still deliver buffered messages before close completes.
			if (closing || (record !== null && record.socket !== socket)) return;
			if (isBinary) {
				fatal(protocolFailure("INVALID_FRAME", "Binary WebSocket frames are not accepted"));
				return;
			}
			let frame;
			try {
				frame = parseHostClientFrame(deserializeHostFrame(websocketText(data)));
			} catch {
				fatal(protocolFailure("INVALID_FRAME", "Ling host received an invalid protocol frame"));
				return;
			}
			if (clientId === null) {
				if (frame.kind !== "hello") {
					fatal(protocolFailure("UNAUTHORIZED", "Ling host requires authentication before requests"));
					return;
				}
				const authenticated = acceptClientHello({ frame, clients, socket, token, helloTimer, hostId, options, fatal });
				if (authenticated === null) return;
				({ clientId, record, releaseEvents } = authenticated);
				return;
			}
			if (frame.kind === "hello") {
				fatal(protocolFailure("INVALID_FRAME", "Ling host received a duplicate hello frame"));
				return;
			}
			if (!record) {
				fatal(protocolFailure("INTERNAL_ERROR", "Ling host client state is unavailable"));
				return;
			}
			if (frame.kind === "ack") {
				for (const requestId of frame.requestIds) record.replays.delete(requestId);
				return;
			}
			if (frame.kind === "cancel") {
				record.active.get(frame.id)?.controller.abort(new Error("Ling host request was cancelled"));
				return;
			}
			dispatchClientRequest({ router: options.router, record, clientId, socket, frame, fatal });
		});
		socket.on("close", (code, reason) => {
			clearTimeout(helloTimer);
			releaseEvents?.();
			sockets.delete(socket);
			const closeReason = reason.toString("utf8").slice(0, 123);
			log.info(
				`Host WebSocket closed authenticated=${String(clientId !== null)} code=${String(code)}${closeReason.length === 0 ? "" : ` reason=${closeReason}`}`,
			);
			if (closing || clientId === null || record?.socket !== socket) return;
			record.socket = null;
			record.disconnectTimer = setTimeout(() => {
				if (!record || record.socket !== null || clientId === null) return;
				for (const request of record.active.values()) {
					request.controller.abort(new Error("Ling host client reconnect grace expired"));
				}
				record.active.clear();
				record.replays.clear();
				clients.delete(clientId);
				options.onClientDisconnected?.(clientId);
			}, HOST_CLIENT_RECONNECT_GRACE_MS);
			record.disconnectTimer.unref();
		});
	});

	try {
		await listenOnLoopback(server, options.preferredPort ?? 0);
	} catch (error) {
		if (options.preferredPort === null || (error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
		log.warn(`Preferred loopback port ${String(options.preferredPort)} is busy; assigning a new stable origin`);
		await listenOnLoopback(server, 0);
	}
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Ling host did not receive a TCP port");
	expectedOrigin = `http://127.0.0.1:${String(address.port)}`;
	return {
		hostId,
		origin: expectedOrigin,
		token,
		launchUrl: `${expectedOrigin}/#token=${encodeURIComponent(token)}`,
		close: () => {
			if (closing) return closing;
			const settlement = Promise.withResolvers<void>();
			closing = settlement.promise;
			const failures: unknown[] = [];
			httpSessions.clear();
			for (const [clientId, record] of clients) {
				if (record.disconnectTimer) clearTimeout(record.disconnectTimer);
				for (const request of record.active.values()) request.controller.abort(new Error("Ling host is shutting down"));
				record.active.clear();
				record.replays.clear();
				record.socket = null;
				attemptCleanup(failures, () => options.onClientDisconnected?.(clientId));
			}
			clients.clear();
			for (const socket of sockets) attemptCleanup(failures, () => socket.close(1001, "host shutdown"));
			const closed = new Promise<void>((resolveClosed, rejectClosed) => {
				const timeout = setTimeout(() => {
					for (const socket of sockets) socket.terminate();
					for (const connection of connections) connection.destroy();
				}, HOST_CLOSE_TIMEOUT_MS);
				server.close((error) => {
					clearTimeout(timeout);
					webSockets.close();
					if (error) rejectClosed(error);
					else resolveClosed();
				});
			});
			void closed.then(
				() => {
					if (failures.length > 0) settlement.reject(new AggregateError(failures, "Host client cleanup failed"));
					else settlement.resolve();
				},
				(error: unknown) =>
					settlement.reject(new AggregateError([...failures, toError(error)], "Host server close failed")),
			);
			return closing;
		},
	};
}

/** Admission, replay and response delivery share one authenticated client owner. */
function dispatchClientRequest({
	router,
	record,
	clientId,
	socket,
	frame,
	fatal,
}: {
	router: HostRequestRouter;
	record: ClientRecord;
	clientId: string;
	socket: WebSocket;
	frame: Extract<HostClientFrame, { kind: "request" }>;
	fatal(error: HostProtocolError): void;
}) {
	const fingerprint = requestFingerprint(frame.method, frame.args);
	const replay = record.replays.get(frame.id);
	if (replay) {
		if (replay.fingerprint !== fingerprint) {
			fatal(protocolFailure("REQUEST_ID_CONFLICT", "A request id was reused with different arguments"));
			return;
		}
		sendText(socket, replay.text);
		return;
	}
	const activeRequest = record.active.get(frame.id);
	if (activeRequest) {
		if (activeRequest.fingerprint !== fingerprint) {
			fatal(protocolFailure("REQUEST_ID_CONFLICT", "An active request id was reused with different arguments"));
		}
		return;
	}
	if (
		record.active.size >= HOST_PROTOCOL_PENDING_REQUEST_CAPACITY ||
		record.replays.size >= HOST_CLIENT_REPLAY_CAPACITY
	) {
		fatal(protocolFailure("REQUEST_CAPACITY_EXCEEDED", "Ling host request capacity is full"));
		return;
	}
	const controller = new AbortController();
	const request = { controller, fingerprint };
	record.active.set(frame.id, request);
	void router
		.dispatch(frame.method, { clientId, product: record.product, signal: controller.signal }, frame.args)
		.then(
			(result) => ({ kind: "response", id: frame.id, ok: true, result: result === undefined ? null : result }) as const,
			(error: unknown) => errorResponse(frame.id, error),
		)
		.then((response) => {
			if (record.active.get(frame.id) !== request) return;
			record.active.delete(frame.id);
			const text = serializeResponse(frame.method, response);
			record.replays.set(frame.id, { fingerprint, text });
			if (record.socket) sendText(record.socket, text);
		});
}

/** Authentication transfers a socket into an owned client lifetime and restores its replay cursor. */
function acceptClientHello({
	frame,
	clients,
	socket,
	token,
	helloTimer,
	hostId,
	options,
	fatal,
}: {
	frame: Extract<HostClientFrame, { kind: "hello" }>;
	clients: Map<string, ClientRecord>;
	socket: WebSocket;
	token: string;
	helloTimer: ReturnType<typeof setTimeout>;
	hostId: string;
	options: Pick<HostWebServerOptions, "events" | "environment" | "onClientDisconnected">;
	fatal(error: HostProtocolError): void;
}) {
	if (!tokenMatches(token, frame.token)) {
		fatal(protocolFailure("UNAUTHORIZED", "Ling host authentication failed"));
		return null;
	}
	if (frame.protocolVersion !== HOST_PROTOCOL_VERSION) {
		fatal(protocolFailure("PROTOCOL_MISMATCH", "Ling host and client protocol versions differ"));
		return null;
	}
	const existing = clients.get(frame.clientId);
	if (!existing && clients.size >= HOST_CLIENT_CAPACITY) {
		fatal(protocolFailure("REQUEST_CAPACITY_EXCEEDED", "Ling host client capacity is full"));
		return null;
	}
	if (existing && existing.product !== frame.product) {
		fatal(protocolFailure("INVALID_FRAME", "A Ling client id cannot change product kind"));
		return null;
	}
	const clientId = frame.clientId;
	const record =
		existing ??
		({
			active: new Map(),
			disconnectTimer: null,
			product: frame.product,
			replays: new Map(),
			socket: null,
		} satisfies ClientRecord);
	clients.set(clientId, record);
	if (record.disconnectTimer) {
		clearTimeout(record.disconnectTimer);
		record.disconnectTimer = null;
	}
	if (frame.lastEventSequence === null && existing) {
		for (const request of record.active.values()) {
			request.controller.abort(new Error("Ling host client started a fresh browser lifetime"));
		}
		record.active.clear();
		record.replays.clear();
		// A page reload keeps its tab ID, but cannot retain the previous page's buffers or editor connections.
		options.onClientDisconnected?.(clientId);
	} else if (existing) {
		// The reconnecting client is authoritative about requests it still awaits. A
		// response whose ACK was lost just before disconnect is absent from this set;
		// retaining it forever would eventually exhaust the replay cache.
		const pendingRequestIds = new Set(frame.pendingRequestIds);
		for (const requestId of record.replays.keys()) {
			if (!pendingRequestIds.has(requestId)) record.replays.delete(requestId);
		}
	}
	const replacedSocket = record.socket;
	record.socket = socket;
	if (replacedSocket && replacedSocket !== socket) replacedSocket.close(1008, "client replaced");
	clearTimeout(helloTimer);
	const replay =
		frame.lastEventSequence === null ? null : options.events.replaySince(frame.lastEventSequence, frame.clientId);
	const resume =
		frame.lastEventSequence === null ? "fresh" : replay?.status === "available" ? "resumed" : "reload-required";
	const releaseEvents = options.events.subscribe((event) => {
		if (event.targetClientId !== null && event.targetClientId !== clientId) return null;
		sendFrame(socket, {
			kind: "event",
			sequence: event.sequence,
			channel: event.channel,
			payload: event.payload,
		});
	});
	sendFrame(socket, {
		kind: "welcome",
		protocolVersion: HOST_PROTOCOL_VERSION,
		hostId,
		eventSequence:
			frame.lastEventSequence !== null && replay?.status === "available"
				? frame.lastEventSequence
				: options.events.currentSequence(),
		resume,
		environment: options.environment,
	});
	log.info(`Host WebSocket welcomed product=${frame.product} resume=${resume}`);
	if (replay?.status === "available") {
		for (const event of replay.events) {
			sendFrame(socket, {
				kind: "event",
				sequence: event.sequence,
				channel: event.channel,
				payload: event.payload,
			});
		}
	}
	return { clientId, record, releaseEvents };
}
