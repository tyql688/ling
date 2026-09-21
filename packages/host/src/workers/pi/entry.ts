import { toError } from "@ling/core/ling-error";
import { configureLoggerOutput, createLogger } from "@ling/core/logger";
import type { PiWorkerParentMessage } from "@ling/core/pi-protocol/protocol";
import { PI_WORKER_PROTOCOL_VERSION } from "@ling/core/pi-protocol/wire-format";
import { parsePiWorkerParentMessage } from "@ling/core/pi-protocol/protocol-validation";
import { type PiWorkerServer, startPiWorkerServer } from "@ling/core/pi-sdk/entrypoints/pi-worker";
import { ChildPiWorkerControlPort } from "@ling/host/workers/pi/pi-worker-node-control";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { getHeapStatistics } from "node:v8";

// Structured lines go straight to fd 2, untouched by extensions that redirect console.*.
configureLoggerOutput({ process: "pi-worker", structured: true });
const log = createLogger("pi-worker");
if (!process.send) throw new Error("pi-worker-entry requires a parent process channel");

// Only this entry may end the process. Extensions run in-process and some libraries end
// their CLI error paths with process.exit(); here that would take every live session down.
// Turn such a call into an exception on the caller's own stack (survived by the handlers
// below) and keep the real exit for the shutdown paths in this file.
const exitProcess: (code: number) => never = process.exit.bind(process);
process.exit = (code?: number) => {
	const error = new Error(`process.exit(${String(code ?? 0)}) blocked: only pi-worker-entry may end the Pi worker`);
	log.error("extension or library attempted to exit the Pi worker:", error);
	throw error;
};

let server: PiWorkerServer | null = null;
let generation: number | null = null;
let fatalPromise: Promise<void> | null = null;
let shutdownPromise: Promise<void> | null = null;
let pendingShutdownGeneration: number | null = null;

function shutdownAndExit(): void {
	if (shutdownPromise) return;
	shutdownPromise = (server?.shutdown() ?? Promise.resolve()).then(
		() => exitProcess(0),
		(error: unknown) => {
			log.error("shutdown failed:", error);
			exitProcess(1);
		},
	);
}

function fatal(error: Error): void {
	if (fatalPromise) return;
	log.error("fatal:", error);
	const forceExit = setTimeout(() => exitProcess(1), 5_000);
	forceExit.unref();
	fatalPromise = (server?.shutdown() ?? Promise.resolve())
		.catch((shutdownError: unknown) => {
			log.error("fatal shutdown failed:", shutdownError);
		})
		.finally(() => {
			clearTimeout(forceExit);
			exitProcess(1);
		});
}

const nodeControlPort = new ChildPiWorkerControlPort();
const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
eventLoopDelay.enable();

function postParent(message: PiWorkerParentMessage): void {
	if (process.send) process.send(message);
	else throw new Error("Pi worker parent process channel is closed");
}

function handleParentMessage(value: unknown): void {
	try {
		if (nodeControlPort?.accept(value)) return;
		const message = parsePiWorkerParentMessage(value);
		if (message.kind === "attachControl") {
			if (server !== null || generation !== null) throw new Error("Pi worker control port is already attached");
			generation = message.generation;
			server = startPiWorkerServer({
				role: message.role,
				port: nodeControlPort,
				generation,
				systemProxyFallback: message.systemProxyFallback,
				onFatal: fatal,
			});
			if (pendingShutdownGeneration !== null) {
				if (pendingShutdownGeneration !== generation) {
					throw new Error("Pi worker received shutdown for a different generation before control attachment");
				}
				shutdownAndExit();
			}
			return;
		}
		if (message.kind === "shutdown" && generation === null) {
			pendingShutdownGeneration = message.generation;
			return;
		}
		if (generation !== message.generation) return;
		if (message.kind === "ping") {
			postParent({
				kind: "pong",
				protocolVersion: PI_WORKER_PROTOCOL_VERSION,
				generation: message.generation,
				sentAt: message.sentAt,
				heapUsedBytes: process.memoryUsage().heapUsed,
				heapLimitBytes: getHeapStatistics().heap_size_limit,
				eventLoopDelayMs: Math.round(eventLoopDelay.max / 1e6),
			} satisfies PiWorkerParentMessage);
			eventLoopDelay.reset();
			return;
		}
		if (message.kind === "shutdown") {
			shutdownAndExit();
		}
	} catch (error) {
		fatal(toError(error));
	}
}

process.on("message", (value) => handleParentMessage(value));

// User-installed extensions run in this process and leak rejections / throw from detached
// timers (e.g. a JSON-RPC write to an LSP child they just killed). Those must never take the
// host — and every live session — down: log and keep serving. A host that is genuinely
// wedged is still caught by the supervisor heartbeat and per-request timeouts; only Ling's
// own protocol paths above call fatal().
process.on("uncaughtException", (error) => log.error("uncaught exception, host kept alive:", error));
process.on("unhandledRejection", (error) => log.error("unhandled rejection, host kept alive:", toError(error)));
