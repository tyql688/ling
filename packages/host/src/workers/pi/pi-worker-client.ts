import type { DiagnosticProcess } from "@ling/contracts/diagnostics";
import type { ProjectTrustChoice } from "@ling/contracts/project";
import type { CompanionToolCall, CompanionToolResult, PiAdapterPlan } from "@ling/contracts/companions";
import type { SessionRef } from "@ling/contracts/session";
import { sessionKey } from "@ling/contracts/session-ref";
import type { PiTurnLifecycleHost } from "@ling/core/pi-protocol/turn-review";
import type { ExtensionUiBridge } from "@ling/core/pi-protocol/extension-ui";
import { throwAggregateFailures } from "@ling/core/ling-error";
import { createLogger } from "@ling/core/logger";
import { pathIdentity } from "@ling/core/paths";
import type {
	PiWorkerCreateRuntimeParams,
	PiWorkerForkRuntimeParams,
	PiWorkerResumeRuntimeParams,
} from "@ling/core/pi-protocol/protocol";
import { parsePiWorkerEvent } from "@ling/core/pi-protocol/protocol-validation";
import type { PiWorkerRuntimeTransport } from "@ling/host/workers/pi/pi-worker-runtime-mirror";
import {
	createPiWorkerRemoteRuntime,
	type PiWorkerRemoteRuntime,
} from "@ling/host/workers/pi/pi-worker-session-runtime";
import type { SessionRuntimeForkSource, SessionRuntimePort } from "@ling/core/pi-protocol/runtime-port";
import type {
	BeforeBindSession,
	CreateSessionRuntimeOptions,
	SessionRuntimeProvider,
} from "@ling/core/pi-protocol/runtime-provider";
import { randomUUID } from "node:crypto";
import { createPiWorkerDomainClient, type PiWorkerDomainClient } from "./pi-worker-domain-client";
import { createPiWorkerMainRequestHandler } from "./pi-worker-main-request-handler";
import {
	cleanupPiWorkerCreationContext,
	createPiWorkerMainRpc,
	type PiWorkerCreationContext,
} from "./pi-worker-main-rpc";
import { createPiWorkerPool, type PiWorkerPool } from "./pi-worker-pool";
import type { PiWorkerGeneration } from "./pi-worker-process";
import { createPiWorkerRequestTransport } from "./pi-worker-request-transport";

const CREATION_EVENT_CAPACITY = 1_024;
const log = createLogger("pi-worker-client");

export interface PiWorkerClient extends SessionRuntimeProvider, PiWorkerDomainClient {
	start(): Promise<void>;
	listProcesses(): DiagnosticProcess[];
	dispose(): Promise<void>;
}

interface PiWorkerClientOptions {
	extensionUi: ExtensionUiBridge;
	runPluginTool(value: unknown, signal: AbortSignal): Promise<string>;
	invokeCompanionTool(call: CompanionToolCall, signal: AbortSignal): Promise<CompanionToolResult>;
	readAdapterPlan(cwd: string): Promise<PiAdapterPlan>;
	promptProjectTrust(cwd: string, signal?: AbortSignal): Promise<ProjectTrustChoice | null>;
	turnLifecycleHost: PiTurnLifecycleHost;
	hostEnvironment(): Record<string, string>;
	systemProxyFallback(): string | null;
}

interface SessionWorker {
	runtimeId: string;
	cwd: string;
	host: PiWorkerGeneration;
	runtime: PiWorkerRemoteRuntime | null;
}

/**
 * Domain methods go to the control worker; every runtime lives in its own session worker.
 * Losing a session worker fails exactly that runtime, and the session stays resumable.
 */
export function createPiWorkerClient(options: PiWorkerClientOptions): PiWorkerClient {
	let disposePromise: Promise<void> | null = null;
	const creationContexts = new Map<string, PiWorkerCreationContext>();
	const workersByRuntime = new Map<string, SessionWorker>();
	const workersByHost = new Map<PiWorkerGeneration, SessionWorker>();
	const runtimeIds = new WeakMap<SessionRuntimePort, string>();
	const extensionEventSequences = new WeakMap<PiWorkerGeneration, number>();
	let pool: PiWorkerPool;
	let domainClient: PiWorkerDomainClient;
	const requestTransport = createPiWorkerRequestTransport({
		creationContexts,
		ensureHost: () => pool.control(),
		failHost: (host, error) => pool.fail(host, error),
		failHostGracefully: (host, error) => pool.failGracefully(host, error),
	});
	const call = requestTransport.call;

	const mainRpc = createPiWorkerMainRpc({
		extensionUi: options.extensionUi,
		runPluginTool: options.runPluginTool,
		invokeCompanionTool: options.invokeCompanionTool,
		readAdapterPlan: options.readAdapterPlan,
		getRuntime: (runtimeId) => workersByRuntime.get(runtimeId)?.runtime ?? undefined,
		getCreation: (requestId) => creationContexts.get(requestId),
		promptProjectTrust: options.promptProjectTrust,
		turnLifecycleHost: options.turnLifecycleHost,
	});
	const mainRequestHandler = createPiWorkerMainRequestHandler({
		rpc: mainRpc,
		failHost: (host, error) => pool.fail(host, error),
	});

	const rejectCreationContextsForHost = (host: PiWorkerGeneration): unknown[] => {
		const failures: unknown[] = [];
		for (const [requestId, context] of creationContexts) {
			if (context.hostGeneration !== host.generation) continue;
			creationContexts.delete(requestId);
			try {
				cleanupPiWorkerCreationContext(context);
			} catch (error) {
				failures.push(error);
			}
		}
		return failures;
	};

	const settleHostEvent = (host: PiWorkerGeneration, value: unknown): void => {
		const event = parsePiWorkerEvent(value);
		if (event.generation !== host.generation) return;
		if (domainClient.handleEvent(event)) return;
		const worker = workersByHost.get(host);
		const runtime = worker?.runtime ?? null;
		if (event.kind === "extensionUiState") {
			const lastSequence = extensionEventSequences.get(host) ?? 0;
			if (event.sequence <= lastSequence) return;
			extensionEventSequences.set(host, event.sequence);
			const creation = [...creationContexts.values()].find(
				(context) => context.runtimeId === event.runtimeId && context.hostGeneration === host.generation,
			);
			const owned =
				(runtime !== null && worker?.runtimeId === event.runtimeId && runtime.acceptsExtensionUiRef(event.ref)) ||
				creation?.boundRefs.has(sessionKey(event.ref)) === true;
			if (!owned) return;
			try {
				options.extensionUi.emitExtensionUiState(event.ref, event.event);
			} catch (error) {
				log.error("Pi worker extension UI observer failed:", error);
			}
			return;
		}
		if (runtime === null || worker?.runtimeId !== event.runtimeId) {
			const creation = [...creationContexts.values()].find(
				(context) => context.runtimeId === event.runtimeId && context.hostGeneration === host.generation,
			);
			if (!creation) return;
			if (creation.pendingEvents.length >= CREATION_EVENT_CAPACITY) {
				throw new Error(`Pi worker emitted too many events while attaching ${event.runtimeId}`);
			}
			creation.pendingEvents.push(event);
			return;
		}
		runtime.handleHostEvent(event);
	};

	const handleControlFrame = (host: PiWorkerGeneration, value: unknown): void => {
		if (!value || typeof value !== "object" || !("kind" in value)) throw new Error("Invalid Pi worker frame");
		const kind = (value as { kind?: unknown }).kind;
		if (kind === "result" || kind === "error" || kind === "resultChunk") requestTransport.settleResponse(host, value);
		else if (kind === "mainRequest") mainRequestHandler.handle(host, value);
		else if (kind === "mainCancel") mainRequestHandler.cancel(host, value);
		else if (
			typeof kind === "string" &&
			(kind.startsWith("runtime") ||
				kind === "extensionUiState" ||
				kind === "modelCatalogChanged" ||
				kind === "modelLoginEvent" ||
				kind === "modelOpenExternal")
		) {
			settleHostEvent(host, value);
		} else {
			throw new Error(`Unexpected Pi worker frame: ${String(kind)}`);
		}
	};

	const handleHostFailure = (host: PiWorkerGeneration, error: Error): void => {
		requestTransport.rejectHost(host, error);
		mainRequestHandler.abortHost(host, error);
		const cleanupFailures = rejectCreationContextsForHost(host);
		const worker = workersByHost.get(host);
		if (worker) {
			workersByHost.delete(host);
			workersByRuntime.delete(worker.runtimeId);
			worker.runtime?.handleHostLost(
				Object.assign(new Error("The Pi worker stopped; this session must be resumed.", { cause: error }), {
					code: "PI_HOST_LOST" as const,
					retryable: true,
					category: "lifecycle" as const,
					userAction: "retry" as const,
				}),
			);
		}
		void mainRpc.abortGeneration(host.generation).catch((abortError: unknown) => {
			log.error(`Pi worker generation ${host.generation} reservation cleanup failed:`, abortError);
		});
		throwAggregateFailures(cleanupFailures, "Failed to release Pi worker creation contexts");
	};

	pool = createPiWorkerPool({
		hostEnvironment: options.hostEnvironment,
		systemProxyFallback: options.systemProxyFallback,
		activeRequestDeadline: requestTransport.activeRequestDeadline,
		pendingRequests: requestTransport.pendingRequests,
		onControlFrame: handleControlFrame,
		onFailed: handleHostFailure,
	});

	domainClient = createPiWorkerDomainClient(call);

	const attachedSessionWorkers = (cwds?: readonly string[]): SessionWorker[] =>
		[...workersByRuntime.values()].filter(
			(worker) => worker.runtime !== null && (cwds === undefined || cwds.includes(worker.cwd)),
		);

	/** Requests that mutate project resources reach every worker holding that project. */
	const fanOut = async (
		workers: SessionWorker[],
		operation: (worker: SessionWorker) => Promise<unknown>,
	): Promise<void> => {
		const results = await Promise.allSettled(workers.map((worker) => operation(worker)));
		throwAggregateFailures(
			results.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
			"Pi session workers could not all apply the change",
		);
	};

	const registerRuntime = async (
		method: "runtime.create" | "runtime.resume" | "runtime.fork",
		params: PiWorkerCreateRuntimeParams | PiWorkerResumeRuntimeParams | PiWorkerForkRuntimeParams,
		expectedCwd: string,
		beforeBind?: BeforeBindSession,
	): Promise<SessionRuntimePort> => {
		const runtimeId = params.runtimeId;
		const worker: SessionWorker = {
			runtimeId,
			cwd: expectedCwd,
			host: pool.spawnSession({
				runtimeId,
				cwd: expectedCwd,
				sessionId: () => workersByRuntime.get(runtimeId)?.runtime?.ref.sessionId,
			}),
			runtime: null,
		};
		workersByRuntime.set(runtimeId, worker);
		workersByHost.set(worker.host, worker);
		const creation: PiWorkerCreationContext = {
			runtimeId,
			expectedCwd,
			...(beforeBind === undefined ? {} : { beforeBind }),
			boundRefs: new Map(),
			pendingEvents: [],
		};
		const releaseWorker = async (): Promise<void> => {
			workersByRuntime.delete(runtimeId);
			workersByHost.delete(worker.host);
			try {
				await pool.release(worker.host);
			} finally {
				await mainRpc.abortGeneration(worker.host.generation);
			}
		};
		let attachedRef: SessionRef | null = null;
		try {
			const bootstrap = await call(method, params, { creation, host: worker.host.readyPromise });
			if (bootstrap.runtimeId !== runtimeId) throw new Error("Pi worker returned a mismatched runtime bootstrap");
			attachedRef = bootstrap.state.ref;
			if (pathIdentity(bootstrap.state.ref.cwd) !== pathIdentity(expectedCwd)) {
				throw new Error("Pi worker runtime bootstrap returned a session from a different project");
			}
			if (worker.host.state !== "ready") throw new Error("Pi worker exited before the runtime could attach");
			const transport: PiWorkerRuntimeTransport = {
				call: (callMethod, callParams, callOptions) =>
					call(callMethod, callParams, { ...callOptions, host: worker.host.readyPromise }),
				release: () => {
					void releaseWorker().catch((error: unknown) =>
						log.error(`Pi session worker ${runtimeId} did not stop cleanly:`, error),
					);
				},
				fail: (_runtimeId, error) => pool.fail(worker.host, error),
			};
			const runtime = createPiWorkerRemoteRuntime(runtimeId, bootstrap.state, transport, creation.pendingEvents);
			creation.pendingEvents.length = 0;
			worker.runtime = runtime;
			runtimeIds.set(runtime, runtimeId);
			return runtime;
		} catch (error) {
			const failures: unknown[] = [error];
			try {
				cleanupPiWorkerCreationContext(creation);
			} catch (cleanupError) {
				failures.push(cleanupError);
			}
			if (worker.host.state === "ready" && attachedRef !== null) {
				try {
					await call(
						"runtime.dispose",
						{
							runtimeId,
							ref: attachedRef,
							...(method === "runtime.resume" ? {} : { args: { rollbackSessionFile: true } }),
						},
						{ host: worker.host.readyPromise },
					);
				} catch (cleanupError) {
					failures.push(cleanupError);
				}
			}
			try {
				await releaseWorker();
			} catch (cleanupError) {
				failures.push(cleanupError);
			}
			if (failures.length === 1) throw error;
			throw new AggregateError(failures, `Failed to attach and release Pi runtime ${runtimeId}`);
		}
	};

	const provider: PiWorkerClient = {
		...domainClient,
		prepareShutdown: async () => {
			await Promise.all([
				domainClient.prepareShutdown(),
				fanOut(attachedSessionWorkers(), (worker) =>
					call("host.prepareShutdown", {}, { host: worker.host.readyPromise }),
				),
			]);
		},
		reloadProjectSettings: async (projectCwds) => {
			const cwds = [...(projectCwds ?? domainClient.listOpenProjectPaths())];
			await Promise.all([
				domainClient.reloadProjectSettings(cwds),
				fanOut(attachedSessionWorkers(cwds), (worker) =>
					call("project.reloadSettings", { projectCwds: [worker.cwd] }, { host: worker.host.readyPromise }),
				),
			]);
		},
		refreshSettingsSnapshots: async () => {
			await Promise.all([
				domainClient.refreshSettingsSnapshots(),
				fanOut(attachedSessionWorkers(), (worker) =>
					call("project.refreshSettingsSnapshots", { projectCwds: [worker.cwd] }, { host: worker.host.readyPromise }),
				),
			]);
		},
		async start() {
			await pool.control();
		},
		listProcesses: () => pool.listProcesses(),
		create(cwd, createOptions: CreateSessionRuntimeOptions = {}) {
			const canonicalCwd = domainClient.resolveProject(cwd);
			return registerRuntime(
				"runtime.create",
				{
					runtimeId: `runtime-${randomUUID()}`,
					cwd: canonicalCwd,
					...(createOptions.model === undefined ? {} : { model: createOptions.model }),
					...(createOptions.thinkingLevel === undefined ? {} : { thinkingLevel: createOptions.thinkingLevel }),
				},
				canonicalCwd,
				createOptions.beforeBind,
			);
		},
		resume(cwd, sessionFilePath, createdAt, resumeOptions = {}) {
			const canonicalCwd = domainClient.resolveProject(cwd);
			return registerRuntime(
				"runtime.resume",
				{ runtimeId: `runtime-${randomUUID()}`, cwd: canonicalCwd, sessionFilePath, createdAt },
				canonicalCwd,
				resumeOptions.beforeBind,
			);
		},
		fork(source: SessionRuntimeForkSource, entryId, title, forkOptions = {}) {
			if (!runtimeIds.has(source as SessionRuntimePort)) {
				return Promise.reject(new Error("Fork source is not owned by the Pi worker"));
			}
			if (!source.sessionFile) {
				return Promise.reject(new Error("Session has no history yet — send a message before forking"));
			}
			return registerRuntime(
				"runtime.fork",
				{
					runtimeId: `runtime-${randomUUID()}`,
					cwd: source.cwd,
					sourceSessionFilePath: source.sessionFile,
					entryId,
					title,
				},
				source.cwd,
				forkOptions.beforeBind,
			);
		},
		dispose() {
			if (disposePromise) return disposePromise;
			disposePromise = (async () => {
				const hosts = [
					...(pool.currentControl() ? [pool.currentControl() as PiWorkerGeneration] : []),
					...workersByHost.keys(),
				];
				const failures: unknown[] = [];
				try {
					await pool.dispose();
				} catch (error) {
					failures.push(error);
				}
				const error = new Error("Pi worker client is shutting down");
				for (const host of hosts) {
					requestTransport.rejectHost(host, error);
					mainRequestHandler.abortHost(host, error);
					failures.push(...rejectCreationContextsForHost(host));
					try {
						await mainRpc.abortGeneration(host.generation);
					} catch (abortError) {
						failures.push(abortError);
					}
				}
				throwAggregateFailures(failures, "Failed to dispose the Pi worker client");
			})();
			return disposePromise;
		},
	};

	return provider;
}
