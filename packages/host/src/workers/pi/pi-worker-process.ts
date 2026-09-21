import type { DiagnosticCorrelation, DiagnosticProcessRole } from "@ling/contracts/diagnostics";
import { toError } from "@ling/core/ling-error";
import { createLogger } from "@ling/core/logger";
import type { PiWorkerParentMessage } from "@ling/core/pi-protocol/protocol";
import { PI_WORKER_PROTOCOL_VERSION } from "@ling/core/pi-protocol/wire-format";
import {
	parsePiWorkerParentMessage,
	parsePiWorkerReady,
	parsePiWorkerShutdownFrame,
} from "@ling/core/pi-protocol/protocol-validation";
import { createToolchainChildEnvironment } from "@ling/host/runtime/host-child-environment";
import { ParentPiWorkerControlPort, type PiWorkerControlPort } from "@ling/host/workers/pi/pi-worker-node-control";
import type { ChildProcess } from "node:child_process";
import { type HostWorkerProcess, spawnHostWorkerProcess } from "../host-worker-process";
import { shutdownPiWorkerGeneration } from "./pi-worker-generation-shutdown";

const log = createLogger("pi-worker");

const READY_TIMEOUT_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 10_000;
const HEARTBEAT_TIMEOUT_MS = 30_000;
/** Recycle a worker before it reaches its V8 heap limit; a fatal abort would lose the diagnostics. */
const HEAP_RECYCLE_FRACTION = 0.9;
const HEAP_WARN_FRACTION = 0.75;

export interface PiWorkerGeneration {
	readonly role: DiagnosticProcessRole;
	readonly generation: number;
	readonly label: string;
	readonly worker: HostWorkerProcess;
	readonly child: ChildProcess;
	readonly port: PiWorkerControlPort;
	readonly startedAt: number;
	state: "starting" | "ready" | "failed" | "stopping";
	lastPongAt: number;
	heapUsedBytes: number;
	heapLimitBytes: number;
	eventLoopDelayMs: number;
	heapWarned: boolean;
	readonly readyPromise: Promise<PiWorkerGeneration>;
	resolveReady(host: PiWorkerGeneration): void;
	rejectReady(error: Error): void;
	readonly exitPromise: Promise<number>;
	resolveExit(code: number): void;
	readonly shutdownComplete: Promise<void>;
	shutdownAcknowledged: boolean;
	resolveShutdownComplete(): void;
	readyTimer: ReturnType<typeof setTimeout>;
	heartbeatTimer: ReturnType<typeof setInterval> | null;
	heartbeatDeferred: boolean;
	failed: boolean;
	exited: boolean;
	retirePromise: Promise<void> | null;
}

export interface PendingRequestSummary {
	method: string;
	ageMs: number;
}

export interface PiWorkerProcessOptions {
	role: Extract<DiagnosticProcessRole, "pi-control" | "pi-session">;
	generation: number;
	label: string;
	hostEnvironment(): Record<string, string>;
	systemProxyFallback(): string | null;
	/** Records from this worker's stdio carry the session it serves. */
	correlation(): DiagnosticCorrelation | undefined;
	activeRequestDeadline(host: PiWorkerGeneration): number | null;
	pendingRequests(host: PiWorkerGeneration): PendingRequestSummary[];
	onControlFrame(host: PiWorkerGeneration, value: unknown): void;
	/** Called once per generation, before retirement starts. */
	onFailed(host: PiWorkerGeneration, error: Error, graceful: boolean): void;
	/** Called after the failed generation's process is gone or retirement gave up. */
	onRetired(host: PiWorkerGeneration, retirementError: unknown): void;
}

const heapMiB = (bytes: number): number => Math.round(bytes / 1048576);

function describePending(pending: PendingRequestSummary[]): string {
	if (pending.length === 0) return "none";
	return pending.map((request) => `${request.method}:${Math.round(request.ageMs / 1000)}s`).join(",");
}

function stopTimers(host: PiWorkerGeneration): void {
	clearTimeout(host.readyTimer);
	if (host.heartbeatTimer) clearInterval(host.heartbeatTimer);
	host.heartbeatTimer = null;
}

function retire(host: PiWorkerGeneration, options: PiWorkerProcessOptions, retirement: Promise<void>): void {
	host.retirePromise = retirement;
	void retirement.then(
		() => options.onRetired(host, null),
		(error: unknown) => {
			if (host.exited) {
				log.error(`${host.label} retirement failed after its process exited:`, error);
				options.onRetired(host, null);
				return;
			}
			options.onRetired(host, error);
		},
	);
}

/** Ends the generation immediately: the process is terminated with its tree. */
export function failPiWorker(host: PiWorkerGeneration, options: PiWorkerProcessOptions, error: Error): void {
	if (host.failed) return;
	host.failed = true;
	host.state = "failed";
	log.write(
		"error",
		`${host.label} failed generation=${host.generation}: ${error.message}; heap=${heapMiB(host.heapUsedBytes)}/${heapMiB(host.heapLimitBytes)}MiB loopDelay=${host.eventLoopDelayMs}ms pending=${describePending(options.pendingRequests(host))}`,
		{ generation: host.generation },
	);
	stopTimers(host);
	host.rejectReady(error);
	try {
		options.onFailed(host, error, false);
	} catch (callbackError) {
		log.error(`${host.label} failure cleanup failed:`, callbackError);
	}
	try {
		host.port.close();
	} catch {
		// The original failure remains the useful diagnosis.
	}
	retire(host, options, host.worker.terminate());
}

/** Ends the generation after its own cleanup: sessions may still flush their files. */
export function failPiWorkerGracefully(host: PiWorkerGeneration, options: PiWorkerProcessOptions, error: Error): void {
	if (host.failed) return;
	host.failed = true;
	host.state = "stopping";
	log.write(
		"error",
		`${host.label} failed generation=${host.generation}; waiting for graceful cleanup: ${error.message}`,
		{
			generation: host.generation,
		},
	);
	stopTimers(host);
	host.rejectReady(error);
	try {
		options.onFailed(host, error, true);
	} catch (callbackError) {
		log.error(`${host.label} failure cleanup failed:`, callbackError);
	}
	retire(host, options, shutdownPiWorkerGeneration(host));
}

/** Orderly stop for a generation that is not failing. */
export async function shutdownPiWorker(host: PiWorkerGeneration): Promise<void> {
	if (host.retirePromise) return host.retirePromise;
	host.state = "stopping";
	host.rejectReady(new Error("Pi worker stopped before it became ready"));
	stopTimers(host);
	host.retirePromise = shutdownPiWorkerGeneration(host);
	return host.retirePromise;
}

export function spawnPiWorkerProcess(options: PiWorkerProcessOptions): PiWorkerGeneration {
	const { generation } = options;
	const {
		promise: readyPromise,
		resolve: resolveReady,
		reject: rejectReady,
	} = Promise.withResolvers<PiWorkerGeneration>();
	const { promise: exitPromise, resolve: resolveExit } = Promise.withResolvers<number>();
	const { promise: shutdownComplete, resolve: resolveShutdownComplete } = Promise.withResolvers<void>();
	// A rejected ready promise nobody awaits (fail before first use) must not surface as unhandled.
	readyPromise.catch(() => undefined);
	const worker = spawnHostWorkerProcess({
		entry: "pi-worker-entry.js",
		label: options.role,
		env: createToolchainChildEnvironment(options.hostEnvironment()),
		...(options.correlation === undefined ? {} : { correlation: options.correlation }),
	});
	const { child } = worker;
	const controlPort = new ParentPiWorkerControlPort(child);
	const host: PiWorkerGeneration = {
		role: options.role,
		generation,
		label: options.label,
		worker,
		child,
		port: controlPort,
		startedAt: Date.now(),
		state: "starting",
		lastPongAt: Date.now(),
		heapUsedBytes: 0,
		heapLimitBytes: 0,
		eventLoopDelayMs: 0,
		heapWarned: false,
		readyPromise,
		resolveReady,
		rejectReady,
		exitPromise,
		resolveExit,
		shutdownComplete,
		shutdownAcknowledged: false,
		resolveShutdownComplete,
		readyTimer: setTimeout(() => fail(new Error("Pi worker ready handshake timed out")), READY_TIMEOUT_MS),
		heartbeatTimer: null,
		heartbeatDeferred: false,
		failed: false,
		exited: false,
		retirePromise: null,
	};
	host.readyTimer.unref();
	const fail = (error: Error): void => failPiWorker(host, options, error);

	const observeHeap = (): void => {
		if (host.failed || host.exited || host.state !== "ready" || host.heapLimitBytes <= 0) return;
		const fraction = host.heapUsedBytes / host.heapLimitBytes;
		if (fraction >= HEAP_WARN_FRACTION && !host.heapWarned) {
			host.heapWarned = true;
			log.write(
				"warn",
				`${host.label} heap at ${heapMiB(host.heapUsedBytes)}/${heapMiB(host.heapLimitBytes)} MiB; an extension may be leaking`,
				{ generation },
			);
		}
		if (fraction < HEAP_RECYCLE_FRACTION || options.pendingRequests(host).length > 0) return;
		failPiWorkerGracefully(
			host,
			options,
			new Error(
				`Pi worker heap at ${heapMiB(host.heapUsedBytes)}/${heapMiB(host.heapLimitBytes)} MiB; recycling before V8 aborts it`,
			),
		);
	};

	const handleControlFrame = (value: unknown): void => {
		try {
			if (!value || typeof value !== "object" || !("kind" in value)) throw new Error("Invalid Pi worker frame");
			const kind = (value as { kind?: unknown }).kind;
			if ((host.failed || host.exited) && kind !== "shutdownComplete") return;
			// A stopping worker still releases leases and reports through main until it acknowledges.
			if (host.state === "stopping" && kind !== "shutdownComplete" && kind !== "mainRequest" && kind !== "mainCancel")
				return;
			if (kind === "ready") {
				if (host.state !== "starting") throw new Error("Pi worker sent more than one ready handshake");
				const ready = parsePiWorkerReady(value);
				if (ready.generation !== generation || ready.pid !== child.pid || ready.piVersion.length === 0) {
					throw new Error("Pi worker ready handshake is invalid");
				}
				host.state = "ready";
				host.lastPongAt = Date.now();
				clearTimeout(host.readyTimer);
				host.resolveReady(host);
				log.write("info", `${host.label} ready pid=${ready.pid} pi=${ready.piVersion}`, { generation });
				return;
			}
			if (kind === "shutdownComplete") {
				if (parsePiWorkerShutdownFrame(value).generation === generation) {
					host.shutdownAcknowledged = true;
					host.resolveShutdownComplete();
				}
				return;
			}
			options.onControlFrame(host, value);
		} catch (error) {
			fail(toError(error));
		}
	};

	controlPort.on("message", (event) => handleControlFrame(event.data));
	controlPort.on("close", () => {
		if (!host.failed && host.state !== "stopping") fail(new Error("Pi worker control port closed"));
	});
	controlPort.start();
	child.once("spawn", () => {
		try {
			child.send({
				kind: "attachControl",
				role: options.role === "pi-control" ? "control" : "session",
				protocolVersion: PI_WORKER_PROTOCOL_VERSION,
				generation,
				systemProxyFallback: options.systemProxyFallback(),
			} satisfies PiWorkerParentMessage);
		} catch (error) {
			fail(toError(error));
		}
	});
	child.on("error", (error) => {
		log.error(`${host.label} process error:`, error);
		if (host.state !== "stopping") fail(toError(error));
	});
	child.once("exit", (code) => {
		host.exited = true;
		host.resolveExit(code ?? 1);
		log.write(
			"warn",
			`${host.label} generation=${generation} pid=${child.pid} exited code=${code} state=${host.state}`,
			{
				generation,
			},
		);
		if (host.state !== "stopping") fail(new Error(`Pi worker exited unexpectedly with code ${code}`));
	});
	child.on("message", (value: unknown) => {
		try {
			// shutdownComplete arrives while the generation is stopping; route control envelopes first.
			if (controlPort.accept(value)) return;
			if (host.failed || host.exited || host.state === "stopping") return;
			const message = parsePiWorkerParentMessage(value);
			if (message.kind === "pong" && message.generation === generation) {
				host.lastPongAt = Date.now();
				host.heapUsedBytes = message.heapUsedBytes;
				host.heapLimitBytes = message.heapLimitBytes;
				host.eventLoopDelayMs = message.eventLoopDelayMs;
				observeHeap();
			}
		} catch (error) {
			fail(toError(error));
		}
	});
	host.heartbeatTimer = setInterval(() => {
		if (host.failed || host.exited || host.state === "stopping") return;
		const now = Date.now();
		const activeRequestDeadline = options.activeRequestDeadline(host);
		if (activeRequestDeadline !== null && now <= activeRequestDeadline) {
			host.heartbeatDeferred = true;
		} else if (host.heartbeatDeferred) {
			// A synchronous SDK operation kept the loop from answering; give it a fresh window.
			host.heartbeatDeferred = false;
			host.lastPongAt = now;
		} else if (now - host.lastPongAt > HEARTBEAT_TIMEOUT_MS) {
			fail(new Error("Pi worker heartbeat timed out"));
			return;
		}
		try {
			if (!child.connected) throw new Error("Pi worker process IPC is disconnected");
			child.send({
				kind: "ping",
				protocolVersion: PI_WORKER_PROTOCOL_VERSION,
				generation,
				sentAt: now,
			} satisfies PiWorkerParentMessage);
		} catch (error) {
			fail(toError(error));
		}
	}, HEARTBEAT_INTERVAL_MS);
	host.heartbeatTimer.unref();
	return host;
}
