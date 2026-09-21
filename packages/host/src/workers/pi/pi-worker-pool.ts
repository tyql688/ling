import type { DiagnosticCorrelation, DiagnosticProcess } from "@ling/contracts/diagnostics";
import { requestCapacityExceeded, throwAggregateFailures } from "@ling/core/ling-error";
import { createLogger } from "@ling/core/logger";
import {
	failPiWorker,
	failPiWorkerGracefully,
	type PendingRequestSummary,
	type PiWorkerGeneration,
	type PiWorkerProcessOptions,
	shutdownPiWorker,
	spawnPiWorkerProcess,
} from "./pi-worker-process";

const log = createLogger("pi-worker-pool");

const CONTROL_RESTART_WINDOW_MS = 30_000;
const CONTROL_MAX_RESTARTS = 2;
const CONTROL_RESTART_DELAY_MS = 500;

interface SessionWorkerInfo {
	runtimeId: string;
	cwd: string;
	sessionId(): string | undefined;
}

interface PiWorkerPoolOptions {
	hostEnvironment(): Record<string, string>;
	systemProxyFallback(): string | null;
	activeRequestDeadline(host: PiWorkerGeneration): number | null;
	pendingRequests(host: PiWorkerGeneration): PendingRequestSummary[];
	onControlFrame(host: PiWorkerGeneration, value: unknown): void;
	onFailed(host: PiWorkerGeneration, error: Error): void;
}

export interface PiWorkerPool {
	/** The control worker, spawned on demand and restarted within its budget. */
	control(): Promise<PiWorkerGeneration>;
	currentControl(): PiWorkerGeneration | null;
	/** One fresh worker for one runtime; released with the runtime. */
	spawnSession(info: SessionWorkerInfo): PiWorkerGeneration;
	sessionWorkers(): Iterable<[SessionWorkerInfo, PiWorkerGeneration]>;
	release(host: PiWorkerGeneration): Promise<void>;
	fail(host: PiWorkerGeneration, error: Error): void;
	failGracefully(host: PiWorkerGeneration, error: Error): void;
	listProcesses(): DiagnosticProcess[];
	dispose(): Promise<void>;
}

export function createPiWorkerPool(options: PiWorkerPoolOptions): PiWorkerPool {
	let generationSequence = 0;
	let controlSpawns = 0;
	let disposing = false;
	let disposePromise: Promise<void> | null = null;
	let control: PiWorkerGeneration | null = null;
	let controlSpawn: Promise<PiWorkerGeneration> | null = null;
	let controlRetirement: Promise<void> = Promise.resolve();
	let settleControlRetirement: (() => void) | null = null;
	let controlRestartTimer: ReturnType<typeof setTimeout> | null = null;
	let controlRestartTimes: number[] = [];
	const sessions = new Map<PiWorkerGeneration, SessionWorkerInfo>();
	const processOptions = new Map<PiWorkerGeneration, PiWorkerProcessOptions>();

	const withinRestartBudget = (now: number): boolean => {
		controlRestartTimes = controlRestartTimes.filter((timestamp) => now - timestamp < CONTROL_RESTART_WINDOW_MS);
		return controlRestartTimes.length < CONTROL_MAX_RESTARTS;
	};

	const scheduleControlRestart = (): void => {
		if (disposing || controlRestartTimer || control !== null) return;
		if (!withinRestartBudget(Date.now())) {
			log.error("Pi control worker restart budget exhausted");
			return;
		}
		controlRestartTimer = setTimeout(() => {
			controlRestartTimer = null;
			if (disposing || control !== null) return;
			void spawnControl().catch((error: unknown) => log.error("Pi control worker restart failed:", error));
		}, CONTROL_RESTART_DELAY_MS);
		controlRestartTimer.unref();
	};

	const baseOptions = (
		role: PiWorkerProcessOptions["role"],
		label: string,
		correlation: () => DiagnosticCorrelation | undefined,
		onRetired: PiWorkerProcessOptions["onRetired"],
	): Omit<PiWorkerProcessOptions, "generation"> => ({
		role,
		label,
		correlation,
		hostEnvironment: options.hostEnvironment,
		systemProxyFallback: options.systemProxyFallback,
		activeRequestDeadline: options.activeRequestDeadline,
		pendingRequests: options.pendingRequests,
		onControlFrame: options.onControlFrame,
		onFailed: (host, error) => options.onFailed(host, error),
		onRetired,
	});

	function spawnControlNow(): PiWorkerGeneration {
		const now = Date.now();
		if (controlSpawns > 0) {
			if (!withinRestartBudget(now)) {
				throw requestCapacityExceeded(
					"piHostRestarts",
					CONTROL_MAX_RESTARTS,
					"Pi control worker restart budget is exhausted; retry after the crash window expires",
				);
			}
			controlRestartTimes.push(now);
		}
		controlSpawns += 1;
		generationSequence += 1;
		const generation = generationSequence;
		const spawnOptions: PiWorkerProcessOptions = {
			generation,
			...baseOptions(
				"pi-control",
				"Pi control worker",
				() => undefined,
				(host, retirementError) => {
					processOptions.delete(host);
					settleControlRetirement?.();
					settleControlRetirement = null;
					if (retirementError !== null) {
						log.error("Pi control worker retirement failed; automatic restart suppressed:", retirementError);
						return;
					}
					scheduleControlRestart();
				},
			),
			onFailed: (host, error) => {
				if (control === host) control = null;
				// A replacement waits for this process to be gone; generations fence any late frame.
				const retirement = Promise.withResolvers<void>();
				controlRetirement = retirement.promise;
				settleControlRetirement = retirement.resolve;
				options.onFailed(host, error);
			},
		};
		const host = spawnPiWorkerProcess(spawnOptions);
		processOptions.set(host, spawnOptions);
		control = host;
		return host;
	}

	function spawnControl(): Promise<PiWorkerGeneration> {
		if (disposing) return Promise.reject(new Error("Pi worker pool is shutting down"));
		if (control) return control.readyPromise;
		if (controlSpawn) return controlSpawn;
		if (controlRestartTimer) {
			clearTimeout(controlRestartTimer);
			controlRestartTimer = null;
		}
		const spawn: Promise<PiWorkerGeneration> = controlRetirement
			.then(() => spawnControlNow().readyPromise)
			.finally(() => {
				if (controlSpawn === spawn) controlSpawn = null;
			});
		controlSpawn = spawn;
		return spawn;
	}

	const retirementOf = (host: PiWorkerGeneration): Promise<void> => host.retirePromise ?? Promise.resolve();

	return {
		control() {
			if (disposing) return Promise.reject(new Error("Pi worker pool is shutting down"));
			return control?.readyPromise ?? spawnControl();
		},
		currentControl: () => control,
		spawnSession(info) {
			if (disposing) throw new Error("Pi worker pool is shutting down");
			generationSequence += 1;
			const spawnOptions: PiWorkerProcessOptions = {
				generation: generationSequence,
				...baseOptions(
					"pi-session",
					`Pi session worker ${info.runtimeId}`,
					() => {
						const sessionId = info.sessionId();
						return sessionId === undefined ? undefined : { sessionId };
					},
					(host) => {
						sessions.delete(host);
						processOptions.delete(host);
					},
				),
			};
			const host = spawnPiWorkerProcess(spawnOptions);
			sessions.set(host, info);
			processOptions.set(host, spawnOptions);
			return host;
		},
		sessionWorkers() {
			return [...sessions].map(([host, info]): [SessionWorkerInfo, PiWorkerGeneration] => [info, host]);
		},
		async release(host) {
			if (host.failed) return retirementOf(host);
			const stopped = shutdownPiWorker(host);
			const forget = (): void => {
				sessions.delete(host);
				processOptions.delete(host);
			};
			void stopped.then(forget, forget);
			return stopped;
		},
		fail(host, error) {
			const spawnOptions = processOptions.get(host);
			if (spawnOptions) failPiWorker(host, spawnOptions, error);
		},
		failGracefully(host, error) {
			const spawnOptions = processOptions.get(host);
			if (spawnOptions) failPiWorkerGracefully(host, spawnOptions, error);
		},
		listProcesses() {
			const describe = (host: PiWorkerGeneration, info?: SessionWorkerInfo): DiagnosticProcess => ({
				id: `${host.role}-${host.generation}`,
				role: host.role,
				pid: host.child.pid ?? null,
				generation: host.generation,
				state: host.state,
				startedAt: host.startedAt,
				...(info === undefined ? {} : { cwd: info.cwd }),
				...(info?.sessionId() === undefined ? {} : { sessionId: info.sessionId() as string }),
				heapUsedBytes: host.heapUsedBytes,
				heapLimitBytes: host.heapLimitBytes,
				eventLoopDelayMs: host.eventLoopDelayMs,
				pendingRequests: options.pendingRequests(host).length,
			});
			return [...(control ? [describe(control)] : []), ...[...sessions].map(([host, info]) => describe(host, info))];
		},
		dispose() {
			if (disposePromise) return disposePromise;
			disposing = true;
			if (controlRestartTimer) {
				clearTimeout(controlRestartTimer);
				controlRestartTimer = null;
			}
			disposePromise = (async () => {
				const failures: unknown[] = [];
				const sessionShutdowns = [...sessions.keys()].map((host) =>
					host.failed ? retirementOf(host) : shutdownPiWorker(host),
				);
				for (const result of await Promise.allSettled(sessionShutdowns)) {
					if (result.status === "rejected") failures.push(result.reason);
				}
				try {
					await controlRetirement;
				} catch (error) {
					failures.push(error);
				}
				const host = control;
				control = null;
				if (host) {
					try {
						await (host.failed ? retirementOf(host) : shutdownPiWorker(host));
					} catch (error) {
						failures.push(error);
					}
				}
				throwAggregateFailures(failures, "Failed to shut down the Pi workers cleanly");
			})();
			return disposePromise;
		},
	};
}
