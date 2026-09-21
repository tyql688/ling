import type { ProcedureTransport } from "@ling/contracts/procedure";
import { toError } from "@ling/contracts/ling-error";
import {
	HOST_PROTOCOL_FRAME_MAX_BYTES,
	HOST_PROTOCOL_PENDING_REQUEST_CAPACITY,
	HOST_PROTOCOL_VERSION,
	deserializeHostFrame,
	parseHostServerFrame,
	serializeHostFrame,
	type HostClientFrame,
	type HostProductKind,
	type HostProtocolError,
	type HostResponseError,
	type HostServerFrame,
} from "@ling/contracts/protocol/host-protocol";
import { createPendingRequests } from "@ling/contracts/protocol/pending-requests";
import ReconnectingWebSocket from "partysocket/ws";

type HostWelcome = Extract<HostServerFrame, { kind: "welcome" }>;

export interface HostWebSocketConnection {
	transport: ProcedureTransport;
	welcome: HostWelcome;
	dispose(): void;
}

interface HostWebSocketConnectionOptions {
	url: string;
	token: string;
	clientId: string;
	product: HostProductKind;
	onProtocolError(error: Error): void;
	onReloadRequired(): void;
}

function protocolError(error: HostProtocolError): Error {
	return Object.assign(new Error(error.message), { code: error.code });
}

function responseError(value: HostResponseError): Error {
	if (value.kind === "protocol") return protocolError(value.error);
	return Object.assign(new Error(value.error.message), {
		code: value.error.code,
		lingError: value.error,
	});
}

function socketMessageText(data: unknown): string {
	if (typeof data === "string") return data;
	throw new Error("Ling host sent a non-text WebSocket frame");
}

function send(socket: ReconnectingWebSocket, frame: HostClientFrame | string): void {
	if (socket.readyState !== ReconnectingWebSocket.OPEN) throw new Error("Ling host connection is not open");
	socket.send(typeof frame === "string" ? frame : serializeHostFrame(frame));
}

export async function connectHostWebSocket(options: HostWebSocketConnectionOptions): Promise<HostWebSocketConnection> {
	const listeners = new Map<string, Set<(payload: unknown) => void>>();
	const pending = createPendingRequests<{ serialized: string }>({
		capacity: HOST_PROTOCOL_PENDING_REQUEST_CAPACITY,
		capacityError: () =>
			Object.assign(new Error("Ling host request backlog is full. Wait for an active request to finish, then retry."), {
				code: "REQUEST_CAPACITY_EXCEEDED" as const,
			}),
		createId: () => crypto.randomUUID(),
	});
	/** A reconnect has ten attempts spanning roughly thirty seconds before the loss is surfaced as terminal. */
	const RECONNECT_MAX_ATTEMPTS = 10;
	/** Backoff tops out at five seconds so recovery remains responsive without hot-looping a stopped Host. */
	const RECONNECT_MAX_DELAY_MS = 5_000;
	/** An authenticated Host must answer hello within ten seconds or the socket is considered unusable. */
	const WELCOME_TIMEOUT_MS = 10_000;
	let disposed = false;
	let eventSequence = 0;
	let expectedHostId: string | null = null;
	let welcomed = false;
	let terminalError: Error | null = null;
	let welcomeTimer: ReturnType<typeof setTimeout> | null = null;
	const initial = Promise.withResolvers<HostWelcome>();
	const socket = new ReconnectingWebSocket(options.url, [], {
		startClosed: true,
		maxRetries: RECONNECT_MAX_ATTEMPTS,
		minReconnectionDelay: 100,
		maxReconnectionDelay: RECONNECT_MAX_DELAY_MS,
		reconnectionDelayGrowFactor: 2,
		connectionTimeout: WELCOME_TIMEOUT_MS,
		minUptime: WELCOME_TIMEOUT_MS,
		// Ling must authenticate before replay. The library must never flush business frames on open.
		maxEnqueuedMessages: 0,
		shouldReconnectOnClose(event) {
			if (disposed || terminalError) return false;
			if (expectedHostId === null || socket.retryCount >= RECONNECT_MAX_ATTEMPTS) {
				failTerminal(new Error(`Ling host connection closed (${event.reason || String(event.code)})`));
				return false;
			}
			return true;
		},
	});
	const clearWelcomeTimer = (): void => {
		if (welcomeTimer) clearTimeout(welcomeTimer);
		welcomeTimer = null;
	};
	const failPending = (error: Error): void => pending.rejectWhere(() => true, error);
	function stopSocket(): void {
		clearWelcomeTimer();
		socket.removeEventListener("open", onOpen);
		socket.removeEventListener("message", onMessage);
		socket.removeEventListener("close", onClose);
		socket.removeEventListener("error", onError);
		socket.close();
	}
	function failTerminal(error: Error): void {
		if (terminalError || disposed) return;
		terminalError = error;
		failPending(error);
		initial.reject(error);
		stopSocket();
		if (expectedHostId !== null) options.onProtocolError(error);
	}

	const handleFrame = (frame: Exclude<HostServerFrame, { kind: "welcome" }>): void => {
		if (frame.kind === "fatal") throw protocolError(frame.error);
		if (frame.kind === "response") {
			const request = pending.get(frame.id);
			if (!request) throw new Error(`Ling host responded to unknown request ${frame.id}`);
			if (frame.ok) request.resolve(frame.result);
			else request.reject(responseError(frame.error));
			send(socket, { kind: "ack", eventSequence, requestIds: [frame.id] });
			return;
		}
		if (frame.sequence <= eventSequence) return;
		eventSequence = frame.sequence;
		const callbacks = listeners.get(frame.channel);
		if (callbacks) {
			for (const callback of callbacks) callback(frame.payload);
		}
		send(socket, { kind: "ack", eventSequence, requestIds: [] });
	};

	function onOpen(): void {
		welcomed = false;
		clearWelcomeTimer();
		welcomeTimer = setTimeout(() => failTerminal(new Error("Ling host welcome timed out")), WELCOME_TIMEOUT_MS);
		try {
			send(socket, {
				kind: "hello",
				protocolVersion: HOST_PROTOCOL_VERSION,
				clientId: options.clientId,
				product: options.product,
				token: options.token,
				lastEventSequence: expectedHostId === null ? null : eventSequence,
				pendingRequestIds: [...pending.keys()],
			});
		} catch (error) {
			failTerminal(toError(error));
		}
	}
	function onMessage(message: MessageEvent): void {
		try {
			const frame = parseHostServerFrame(deserializeHostFrame(socketMessageText(message.data)));
			if (!welcomed) {
				if (frame.kind === "fatal") throw protocolError(frame.error);
				if (frame.kind !== "welcome") throw new Error("Ling host sent data before the welcome frame");
				if (frame.protocolVersion !== HOST_PROTOCOL_VERSION)
					throw new Error(
						`Ling host protocol ${String(frame.protocolVersion)} is incompatible with client protocol ${String(HOST_PROTOCOL_VERSION)}`,
					);
				if (expectedHostId !== null && frame.hostId !== expectedHostId)
					throw new Error("Ling host identity changed while reconnecting");
				if (frame.resume === "reload-required") {
					const error = new Error("Ling host event history no longer covers this client");
					disposed = true;
					failPending(error);
					initial.reject(error);
					stopSocket();
					options.onReloadRequired();
					return;
				}
				expectedHostId = frame.hostId;
				eventSequence = frame.eventSequence;
				welcomed = true;
				clearWelcomeTimer();
				initial.resolve(frame);
				for (const request of pending.values()) send(socket, request.context.serialized);
				return;
			}
			if (frame.kind === "welcome") throw new Error("Ling host sent a duplicate welcome frame");
			handleFrame(frame);
		} catch (error) {
			failTerminal(toError(error));
		}
	}
	function onClose(): void {
		welcomed = false;
		clearWelcomeTimer();
	}
	function onError(event: { error?: unknown }): void {
		if (expectedHostId === null || socket.retryCount >= RECONNECT_MAX_ATTEMPTS) {
			// Native WebSocket error events omit the underlying cause; still reject with
			// an Error so the connection failure remains visible and pending calls settle.
			failTerminal(
				event.error === undefined ? new Error("Ling host WebSocket connection failed") : toError(event.error),
			);
		}
	}
	socket.addEventListener("open", onOpen);
	socket.addEventListener("message", onMessage);
	socket.addEventListener("close", onClose);
	socket.addEventListener("error", onError);
	socket.reconnect();
	const welcome = await initial.promise;

	const transport: ProcedureTransport = {
		invoke: async <Result>(channel: string, args: readonly unknown[]): Promise<Result> => {
			if (terminalError) return Promise.reject(terminalError);
			if (disposed) return Promise.reject(new Error("Ling host connection is closed"));
			const id = pending.allocateId();
			const frame: Extract<HostClientFrame, { kind: "request" }> = {
				kind: "request",
				id,
				method: channel,
				args: Array.from(args),
			};
			const serialized = serializeHostFrame(frame);
			if (new TextEncoder().encode(serialized).byteLength > HOST_PROTOCOL_FRAME_MAX_BYTES) {
				throw responseError({
					kind: "domain",
					error: {
						code: "INVALID_REQUEST",
						category: "validation",
						message: "The request is too large to send. Reduce its attachments or text and retry.",
						retryable: false,
						details: { resource: "hostFrame", maxBytes: HOST_PROTOCOL_FRAME_MAX_BYTES },
					},
				});
			}
			// Host welcome/resume/ack owns replay; a reconnect must retain these exact ids.
			const request = pending.create<Result>({ id, context: { serialized }, deadline: null });
			try {
				if (welcomed && socket.readyState === ReconnectingWebSocket.OPEN) send(socket, serialized);
			} catch (error) {
				request.reject(toError(error));
			}
			return request.promise;
		},
		subscribe: <Payload>(channel: string, callback: (payload: Payload) => void): (() => void) => {
			let callbacks = listeners.get(channel);
			if (!callbacks) {
				callbacks = new Set();
				listeners.set(channel, callbacks);
			}
			const untypedCallback = callback as (payload: unknown) => void;
			callbacks.add(untypedCallback);
			let subscribed = true;
			return () => {
				if (!subscribed) return;
				subscribed = false;
				callbacks.delete(untypedCallback);
				if (callbacks.size === 0) listeners.delete(channel);
			};
		},
	};

	return {
		transport,
		welcome,
		dispose: () => {
			if (disposed) return;
			disposed = true;
			const error = new Error("Ling host connection closed");
			failPending(error);
			listeners.clear();
			stopSocket();
		},
	};
}
