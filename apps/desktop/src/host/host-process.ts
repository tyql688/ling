import type { HostConnectionInfo } from "@ling/contracts/host-shell";
import {
	HOST_STDIO_MESSAGE_PREFIX,
	hostSupervisorMessageSchema,
	type HostShellEvent,
	type HostSupervisorMessage,
} from "@ling/contracts/host-shell";
import { errorMessage, toError } from "@ling/contracts/ling-error";

import { terminateProcessTree } from "@ling/node-runtime/process-tree-terminator";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { DesktopLog } from "../shell/log-file-sink";

/** Host startup includes shell discovery and the Pi handshake; thirty seconds exposes a broken package promptly. */
const HOST_READY_TIMEOUT_MS = 30_000;
/** Host shutdown owns nested Pi and PTY children; ten seconds bounds graceful teardown. */
const HOST_SHUTDOWN_TIMEOUT_MS = 10_000;
/** A 1 MiB unterminated stdout line indicates a broken Host control protocol and prevents unbounded shell memory use. */
const HOST_STDOUT_LINE_MAX_BYTES = 1024 * 1024;

interface DesktopHostProcessOptions {
	appResourcesRoot: string;
	userDataDirectory: string;
	desktopLog: DesktopLog;
	onShellEvent(event: HostShellEvent): void;
	onUnexpectedExit(details: { pid: number; code: number | null; signal: NodeJS.Signals | null }): void;
}

export interface DesktopHostProcess {
	child: ChildProcess;
	connection: HostConnectionInfo;
	dispose(): Promise<void>;
}

interface HostExitDetails {
	code: number | null;
	signal: NodeJS.Signals | null;
}

function websocketUrl(origin: string): string {
	const parsed = new URL("/api/ws", origin);
	if (parsed.hostname !== "127.0.0.1" || parsed.protocol !== "http:") {
		throw new Error("Ling Host must bind to loopback HTTP");
	}
	parsed.protocol = "ws:";
	return parsed.href;
}

export async function startDesktopHostProcess(options: DesktopHostProcessOptions): Promise<DesktopHostProcess> {
	const hostRoot = join(options.appResourcesRoot, "host");
	const nodeExecutable = join(options.appResourcesRoot, "runtime", process.platform === "win32" ? "node.exe" : "node");
	const environment = { ...process.env, LING_HOST_STDIO_CONTROL: "1" };
	const child: ChildProcess = spawn(
		nodeExecutable,
		[
			join(hostRoot, "dist/index.js"),
			`--app-root=${hostRoot}`,
			`--resources-dir=${options.appResourcesRoot}`,
			`--static-dir=${join(options.appResourcesRoot, "web")}`,
			`--user-data-dir=${options.userDataDirectory}`,
			"--packaged",
		],
		{
			cwd: hostRoot,
			// The Host treats stdin EOF as supervisor death, so an abrupt Electron exit cannot orphan it.
			stdio: ["pipe", "pipe", "pipe"],
			env: environment,
		},
	);
	let exited = false;
	const exit = new Promise<HostExitDetails>((resolveExit) => {
		child.once("exit", (code, signal) => {
			exited = true;
			resolveExit({ code, signal });
		});
	});
	let controlInputFailure: Error | null = null;
	let resolveControlInputFailure: (error: Error) => void = () => undefined;
	const controlInputFailed = new Promise<Error>((resolveFailure) => {
		resolveControlInputFailure = resolveFailure;
	});
	child.stdin?.on("error", (error: unknown) => {
		const normalized = toError(error);
		controlInputFailure ??= normalized;
		resolveControlInputFailure(normalized);
	});
	let forcedTerminationPromise: Promise<void> | null = null;
	const forceTerminateHostTree = (): Promise<void> => {
		if (forcedTerminationPromise) return forcedTerminationPromise;
		forcedTerminationPromise = (async () => {
			const pid = child.pid;
			if (pid === undefined) {
				child.kill();
				return;
			}
			await terminateProcessTree({
				pid,
				terminateRoot: () => child.kill("SIGTERM"),
				rootExited: () => exited,
			});
		})();
		return forcedTerminationPromise;
	};
	const forceTerminateAfterFailure = async (failure: unknown, aggregateMessage: string): Promise<never> => {
		const normalized = toError(failure);
		try {
			await forceTerminateHostTree();
		} catch (terminationError: unknown) {
			throw new AggregateError([normalized, toError(terminationError)], aggregateMessage);
		}
		throw normalized;
	};
	let controlProtocolFailed = false;
	const failControlProtocol = (reason: string): void => {
		if (controlProtocolFailed) return;
		controlProtocolFailed = true;
		process.stderr.write(`[ling-host] ${reason}\n`);
		void forceTerminateHostTree().catch((error: unknown) => {
			process.stderr.write(`[ling-host] Could not terminate invalid Host process tree: ${errorMessage(error)}\n`);
		});
	};
	let stdoutBuffer = "";
	const stdoutDecoder = new StringDecoder("utf8");
	const supervisorListeners = new Set<(value: HostSupervisorMessage) => void>();
	child.stdout?.on("data", (chunk: Buffer | string) => {
		if (controlProtocolFailed) return;
		stdoutBuffer += typeof chunk === "string" ? chunk : stdoutDecoder.write(chunk);
		let newlineIndex = stdoutBuffer.indexOf("\n");
		while (newlineIndex >= 0) {
			const line = stdoutBuffer.slice(0, newlineIndex);
			stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
			if (Buffer.byteLength(line) > HOST_STDOUT_LINE_MAX_BYTES) {
				failControlProtocol("Host control message exceeded its bounded line length");
				return;
			}
			if (line.startsWith(HOST_STDIO_MESSAGE_PREFIX)) {
				const encoded = line.slice(HOST_STDIO_MESSAGE_PREFIX.length);
				let value: unknown;
				try {
					value = JSON.parse(encoded) as unknown;
				} catch (error: unknown) {
					failControlProtocol(`Invalid control message: ${errorMessage(error)}`);
					return;
				}
				const parsed = hostSupervisorMessageSchema.safeParse(value);
				if (!parsed.success) {
					failControlProtocol("Host sent a control message that does not match the supervisor protocol");
					return;
				}
				for (const listener of supervisorListeners) listener(parsed.data);
			} else if (line.length > 0) {
				process.stdout.write(`[ling-host] ${line}\n`);
			}
			newlineIndex = stdoutBuffer.indexOf("\n");
		}
		if (Buffer.byteLength(stdoutBuffer) > HOST_STDOUT_LINE_MAX_BYTES) {
			failControlProtocol("Host control message exceeded its bounded line length");
		}
	});
	child.stderr?.on("data", (chunk: Buffer | string) => process.stderr.write(`[ling-host] ${chunk.toString()}`));
	const onShellMessage = (value: HostSupervisorMessage): void => {
		if (value.type === "ling-host-shell-event") options.onShellEvent(value.event);
	};
	supervisorListeners.add(onShellMessage);
	const ready = await new Promise<
		Extract<ReturnType<typeof hostSupervisorMessageSchema.parse>, { type: "ling-host-ready" }>
	>((resolveReady, rejectReady) => {
		let timer: ReturnType<typeof setTimeout>;
		const cleanup = (): void => {
			clearTimeout(timer);
			supervisorListeners.delete(onMessage);
			child.off("error", onError);
		};
		timer = setTimeout(() => {
			cleanup();
			rejectReady(new Error("Ling Host startup timed out"));
		}, HOST_READY_TIMEOUT_MS);
		const onMessage = (value: HostSupervisorMessage): void => {
			if (value.type !== "ling-host-ready") return;
			cleanup();
			resolveReady(value);
		};
		const onError = (error: Error): void => {
			cleanup();
			rejectReady(error);
		};
		supervisorListeners.add(onMessage);
		child.once("error", onError);
		void exit.then(({ code, signal }) => {
			cleanup();
			rejectReady(
				new Error(`Ling Host exited before ready (${signal === null ? `code ${String(code)}` : `signal ${signal}`})`),
			);
		});
	}).catch(async (error: unknown) => {
		const startupError = toError(error);
		supervisorListeners.delete(onShellMessage);
		if (!exited) {
			try {
				await forceTerminateHostTree();
			} catch (terminationError: unknown) {
				throw new AggregateError([startupError, toError(terminationError)], "Ling Host startup and cleanup failed");
			}
		}
		throw startupError;
	});
	const releaseLogForwarder = options.desktopLog.attachForwarder((line) => {
		const input = child.stdin;
		if (input && !input.destroyed && !input.writableEnded && controlInputFailure === null) input.write(`${line}\n`);
	});
	let shutdownRequested = false;
	void exit.then((details) => {
		releaseLogForwarder();
		if (shutdownRequested) return;
		const pid = child.pid;
		if (pid !== undefined) options.onUnexpectedExit({ pid, ...details });
	});
	let disposePromise: Promise<void> | null = null;
	return {
		child,
		connection: { url: websocketUrl(ready.origin), token: ready.token },
		dispose() {
			if (disposePromise) return disposePromise;
			shutdownRequested = true;
			releaseLogForwarder();
			disposePromise = (async () => {
				if (!exited) {
					const input = child.stdin;
					if (!input || input.destroyed || input.writableEnded || controlInputFailure !== null) {
						return forceTerminateAfterFailure(
							controlInputFailure ??
								new Error("Ling Host control input closed before graceful shutdown could be requested"),
							"Ling Host shutdown request and forced cleanup both failed",
						);
					}
					try {
						input.end();
					} catch (error: unknown) {
						return forceTerminateAfterFailure(
							error,
							"Ling Host control input and forced cleanup both failed during shutdown",
						);
					}
				}
				let timeout: ReturnType<typeof setTimeout> | null = null;
				try {
					const outcome = await Promise.race([
						exit.then((details) => ({ kind: "exited" as const, details })),
						controlInputFailed.then((error) => ({ kind: "input-error" as const, error })),
						new Promise<{ kind: "timeout" }>((resolveTimeout) => {
							timeout = setTimeout(() => resolveTimeout({ kind: "timeout" }), HOST_SHUTDOWN_TIMEOUT_MS);
						}),
					]);
					if (outcome.kind === "timeout") {
						return forceTerminateAfterFailure(
							new Error("Ling Host graceful shutdown exceeded its ten-second deadline and was force-terminated"),
							"Ling Host graceful-shutdown timeout and forced cleanup both failed",
						);
					}
					if (outcome.kind === "input-error") {
						return forceTerminateAfterFailure(
							new Error("Ling Host control input failed while requesting graceful shutdown", { cause: outcome.error }),
							"Ling Host control input and forced cleanup both failed during shutdown",
						);
					}
					if (outcome.details.code !== 0 || outcome.details.signal !== null) {
						const reason =
							outcome.details.signal === null
								? `exit code ${String(outcome.details.code)}`
								: `signal ${outcome.details.signal}`;
						throw new Error(`Ling Host did not shut down cleanly (${reason})`);
					}
				} finally {
					if (timeout) clearTimeout(timeout);
				}
			})();
			return disposePromise;
		},
	};
}
