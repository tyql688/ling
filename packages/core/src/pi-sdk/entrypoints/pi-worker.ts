import type { BuiltinFeatureFlags } from "@ling/contracts/builtin-features";
import type { PiCallbackInput, PiCallbackResult } from "../../pi-protocol/callback-methods";
import { createPendingRequests } from "@ling/contracts/protocol/pending-requests";
import { createLingSkillResources } from "../resources/skill-toggles";
import { createPiProviderQuotas } from "../models/provider-quotas";
import { createPiModelRuntimes } from "../models/model-runtime";
import { createPiModelProjection } from "../models/model-projection";
import { createPiModelsConfig } from "../models/models-config";
import { createPiModelCredentials } from "../models/model-credentials";
import { createPiModelProviderMutations } from "../models/model-provider-mutations";
import { createPiModelCatalog } from "../models/model-catalog";
import { createPiModelConfiguration } from "../models/model-configuration";
import { createPiModels } from "../models/models";
import { createPiSkillCatalog } from "../resources/skills";
import { createPiSessionRuntimes } from "../session/runtime-entrypoints";
import { createExtensionUiBridge } from "@ling/core/pi-protocol/extension-ui";
import { createPiExtensionUi } from "../extensions/extension-ui-context";
import { lingExtensionFactories } from "@ling/builtin-extensions";
import { PLUGIN_MUTATION_MAX_DEADLINE_MS } from "@ling/contracts/plugin-operation";
import { throwAggregateFailures, toError } from "@ling/core/ling-error";
import { createLogger } from "@ling/core/logger";
import { schedulePiWorkerDeadline } from "../../pi-protocol/deadline";
import { parsePiWorkerMainOperationResult } from "@ling/core/pi-protocol/callback-methods";
import type { PiWorkerControlFrame, PiWorkerMainRequest, PiWorkerResponse } from "../../pi-protocol/protocol";
import type { PiWorkerMainMethod } from "@ling/core/pi-protocol/callback-methods";
import {
	PI_WORKER_PROTOCOL_VERSION,
	PI_WORKER_REQUEST_CAPACITY,
	PI_WORKER_REVERSE_REQUEST_CAPACITY,
} from "../../pi-protocol/wire-format";
import { PI_WORKER_DOMAIN_METHODS, type PiWorkerDomainMethod } from "../../pi-protocol/methods";
import {
	parsePiWorkerCancel,
	parsePiWorkerMainResponse,
	parsePiWorkerRequest,
	parsePiWorkerShutdownFrame,
	piWorkerError,
	piWorkerErrorDto,
} from "../../pi-protocol/protocol-validation";
import { iteratePiWorkerResponseFrames, preparePiWorkerResponse } from "../../pi-protocol/response-stream";
import { getAgentInfo, getPiAgentDir } from "../agent-info";
import { createPiProjectTrustResolver } from "../projects/project-trust";
import { createPiProjectServices } from "../projects/services";
import { createPiTurnLifecycle } from "../session/turn-lifecycle";
import { createPiSettings } from "../settings/settings";
import { createPiWorkerDomainService } from "../worker/pi-worker-domain-service";
import { createPiWorkerRuntimeService } from "../worker/pi-worker-runtime-service";

const DEFAULT_MAIN_REQUEST_TIMEOUT_MS = 24 * 60 * 60_000;
const log = createLogger("pi-worker-server");

interface PiWorkerMessagePort {
	postMessage(message: unknown): void;
	on(event: "message", listener: (event: { data: unknown }) => void): this;
	on(event: "close", listener: () => void): this;
	off(event: "message", listener: (event: { data: unknown }) => void): this;
	off(event: "close", listener: () => void): this;
	start(): void;
	drain?(): Promise<void>;
	close(): void;
}

interface ActiveHostRequest {
	controller: AbortController;
	cancelTimer(): void;
}

export interface PiWorkerServer {
	shutdown(): Promise<void>;
}

interface StartPiWorkerServerOptions {
	role: "control" | "session";
	port: PiWorkerMessagePort;
	generation: number;
	systemProxyFallback: string | null;
	onFatal(error: Error): void;
}

function postPort(port: PiWorkerMessagePort, frame: PiWorkerControlFrame): void {
	port.postMessage(frame);
}

function listenPort(port: PiWorkerMessagePort, listener: (value: unknown) => void): () => void {
	const onMessage = (event: { data: unknown }) => listener(event.data);
	port.on("message", onMessage);
	try {
		port.start();
	} catch (error) {
		port.off("message", onMessage);
		throw error;
	}
	return () => port.off("message", onMessage);
}

export function startPiWorkerServer(options: StartPiWorkerServerOptions): PiWorkerServer {
	const { port, generation } = options;
	let shuttingDown = false;
	let mainClosed = false;
	let shutdownPromise: Promise<void> | null = null;
	const pendingMainRequests = createPendingRequests<{ method: PiWorkerMainMethod }>({
		capacity: PI_WORKER_REVERSE_REQUEST_CAPACITY,
		capacityError: () => new Error("Pi worker main-request capacity is full"),
		createId: (sequence) => `host-${sequence}`,
	});
	const activeHostRequests = new Map<string, ActiveHostRequest>();
	const hostRequestSettlements = new Set<Promise<void>>();

	const post = (frame: PiWorkerControlFrame): void => {
		// Shutdown still needs the reverse channel: runtime disposal and final turn reports
		// go through main until shutdownComplete is posted.
		const mainFrame = frame.kind === "mainRequest" || frame.kind === "mainCancel";
		if (shuttingDown && frame.kind !== "shutdownComplete" && !(mainFrame && !mainClosed)) return;
		postPort(port, frame);
	};

	const callMain = async <Method extends PiWorkerMainMethod>(
		method: Method,
		params: PiCallbackInput<Method>,
		requestOptions: { timeoutMs?: number | null; signal?: AbortSignal } = {},
	): Promise<PiCallbackResult<Method>> => {
		if (mainClosed) throw new Error("Pi worker is shutting down");
		pendingMainRequests.assertCapacity();
		if (requestOptions.signal?.aborted) throw toError(requestOptions.signal.reason);
		const timeoutMs =
			requestOptions.timeoutMs === undefined ? DEFAULT_MAIN_REQUEST_TIMEOUT_MS : requestOptions.timeoutMs;
		if (timeoutMs !== null && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
			throw new Error(`Pi worker main request timeout is invalid: ${method}`);
		}
		const deadlineAt = timeoutMs === null ? null : Math.min(Number.MAX_SAFE_INTEGER, Date.now() + timeoutMs);
		const request = pendingMainRequests.create<PiCallbackResult<Method>>({
			context: { method },
			deadline:
				deadlineAt === null
					? null
					: {
							at: deadlineAt,
							error: () => new Error(`Pi worker main request timed out: ${method}`),
						},
			...(requestOptions.signal === undefined ? {} : { signal: requestOptions.signal }),
			onExpired(reason, error, requestId) {
				try {
					post({ kind: "mainCancel", protocolVersion: PI_WORKER_PROTOCOL_VERSION, generation, requestId });
				} catch (sendError) {
					log.warn(`Failed to send main-request cancellation after ${reason}:`, error, sendError);
				}
			},
		});
		if (pendingMainRequests.get(request.id) === request) {
			const frame: PiWorkerMainRequest = {
				kind: "mainRequest",
				protocolVersion: PI_WORKER_PROTOCOL_VERSION,
				generation,
				requestId: request.id,
				method,
				deadlineAt,
				params,
			};
			try {
				post(frame);
			} catch (error) {
				request.reject(toError(error));
			}
		}
		return request.promise;
	};

	const startupCleanups: (() => void | Promise<void>)[] = [];
	let startupShutdown: (() => Promise<void>) | null = null;
	try {
		const agentDir = getPiAgentDir();
		const settings = createPiSettings(agentDir);
		startupCleanups.push(settings.dispose);
		const { initHttpProxy, applySystemProxyFallback } = settings.network;
		try {
			initHttpProxy();
		} catch (error) {
			log.error("failed to initialize Pi-worker Pi HTTP settings; continuing with available network settings:", error);
		}
		if (options.systemProxyFallback !== null) {
			try {
				applySystemProxyFallback(options.systemProxyFallback);
			} catch (error) {
				log.error("failed to apply the Pi-worker system proxy fallback:", error);
			}
		}

		const resolveProjectTrust = createPiProjectTrustResolver((cwd) => callMain("project.promptTrust", { cwd }));

		const turnLifecycle = createPiTurnLifecycle({
			start: (ref, timestamp, context) => callMain("turn.start", { ref, timestamp, context }),
			finish: (ref, timestamp, fallback, context) => callMain("turn.finish", { ref, timestamp, fallback, context }),
		});
		startupCleanups.push(turnLifecycle.dispose);

		const builtinExtensions = (features: BuiltinFeatureFlags) =>
			lingExtensionFactories(
				(ref, request, signal) =>
					callMain(
						"plugins.run",
						{ ref, request },
						{
							timeoutMs: PLUGIN_MUTATION_MAX_DEADLINE_MS,
							...(signal === undefined ? {} : { signal }),
						},
					),
				(call, signal) => callMain("companions.invoke", call, { timeoutMs: null, ...(signal ? { signal } : {}) }),
				features,
			);

		const extensionUiBridge = createExtensionUiBridge();
		startupCleanups.push(extensionUiBridge.dispose);
		const extensionUi = createPiExtensionUi(extensionUiBridge);
		startupCleanups.push(extensionUi.dispose);
		const modelRuntimes = createPiModelRuntimes(agentDir);
		startupCleanups.push(modelRuntimes.dispose);
		const modelProjection = createPiModelProjection(modelRuntimes);
		const quotas = createPiProviderQuotas(modelRuntimes);
		startupCleanups.push(quotas.dispose);
		const skillResources = createLingSkillResources();
		const projects = createPiProjectServices({
			loadCatalogResources: options.role === "control",
			readAdapterPlan: (cwd) => callMain("adapters.read", { cwd }),
			openVoiceSettings: extensionUi.openVoiceSettings,
			skillResources,
			agentDir,
			modelRuntimes,
			turnLifecycle,
			builtinExtensions,
			resolveProjectTrust,
		});
		startupCleanups.push(() =>
			projects.dispose(async () => {
				/* No runtime can be admitted before the service is attached. */
			}),
		);
		const modelConfig = createPiModelsConfig(modelRuntimes, agentDir);
		const modelProjects = { withOpenProject: projects.withOpenProject };
		const credentials = createPiModelCredentials({ projects: modelProjects, config: modelConfig });
		const providerMutations = createPiModelProviderMutations({
			modelRuntimes,
			config: modelConfig,
			credentials,
			agentDir,
		});
		const catalog = createPiModelCatalog({
			projects: {
				...modelProjects,
				hasProjectProviderCredentialConflict: projects.hasProjectProviderCredentialConflict,
				readStoredProjectCredential: projects.readStoredProjectCredential,
			},
			modelRuntimes,
			projection: modelProjection,
			config: modelConfig,
		});
		const configuration = createPiModelConfiguration({ projects: modelProjects, config: modelConfig });
		const models = createPiModels({
			projects: modelProjects,
			modelRuntimes,
			config: modelConfig,
			catalog,
			credentials,
			providerMutations,
		});
		startupCleanups.push(models.shutdownModelOperations);
		const skills = createPiSkillCatalog({
			projects: {
				getPiServices: projects.getPiServices,
				listOpenProjectPaths: projects.listOpenProjectPaths,
				withOpenProject: projects.withOpenProject,
			},
			settings,
			agentDir,
			skillResources,
		});
		const runtimes = createPiSessionRuntimes({
			extensionUi,
			projects: {
				getOpenProjectCwd: (cwd) => projects.getPiServices(cwd).cwd,
				acquirePiRuntimeServices: projects.acquirePiRuntimeServices,
				releasePiRuntimeServices: projects.releasePiRuntimeServices,
			},
			turnLifecycle,
			modelProjection,
			settings,
		});
		const runtimeService = createPiWorkerRuntimeService({
			projects,
			runtimes,
			extensionUi,
			generation,
			callMain,
			emit: post,
			onFatal: options.onFatal,
		});
		startupCleanups.push(runtimeService.dispose);
		const domainService = createPiWorkerDomainService({
			settings,
			projects,
			models,
			quotas,
			catalog,
			configuration,
			skills,
			generation,
			runtimeService,
			emit: post,
		});
		startupCleanups.push(domainService.dispose);

		const settleMainResponse = (value: unknown): void => {
			const response = parsePiWorkerMainResponse(value);
			if (response.generation !== generation) return;
			const pending = pendingMainRequests.get(response.requestId);
			if (!pending) return;
			if (pending.context.method !== response.method) {
				throw new Error(`Pi worker Main response method mismatch for ${response.requestId}`);
			}
			const result =
				response.kind === "mainResult" ? parsePiWorkerMainOperationResult(response.method, response.result) : null;
			if (response.kind === "mainError") pending.reject(piWorkerError(response.error));
			else pending.resolve(result);
		};

		const postResponse = async (response: PiWorkerResponse, signal?: AbortSignal): Promise<boolean> => {
			try {
				const prepared = preparePiWorkerResponse(response);
				for (const frame of iteratePiWorkerResponseFrames(prepared)) {
					if (signal?.aborted) return false;
					post(frame);
					if (frame.kind === "resultChunk" && !frame.final) {
						await new Promise<void>((resolve) => setImmediate(resolve));
					}
				}
				return true;
			} catch (error) {
				options.onFatal(toError(error));
				return false;
			}
		};

		const releaseHostRequest = (requestId: string, active: ActiveHostRequest): boolean => {
			if (activeHostRequests.get(requestId) !== active) return false;
			activeHostRequests.delete(requestId);
			active.cancelTimer();
			return true;
		};

		const cancelHostRequest = (requestId: string, active: ActiveHostRequest, error: Error): void => {
			if (!releaseHostRequest(requestId, active)) return;
			active.controller.abort(error);
		};

		const handleRequest = (value: unknown): void => {
			const request = parsePiWorkerRequest(value);
			if (request.generation !== generation) return;
			if (Date.now() > request.deadlineAt) {
				void postResponse({
					kind: "error",
					protocolVersion: PI_WORKER_PROTOCOL_VERSION,
					generation,
					requestId: request.requestId,
					method: request.method,
					error: {
						code: "REQUEST_DEADLINE_EXCEEDED",
						message: `Pi worker request deadline exceeded: ${request.method}`,
						retryable: true,
					},
				});
				return;
			}
			if (activeHostRequests.size >= PI_WORKER_REQUEST_CAPACITY || activeHostRequests.has(request.requestId)) {
				void postResponse({
					kind: "error",
					protocolVersion: PI_WORKER_PROTOCOL_VERSION,
					generation,
					requestId: request.requestId,
					method: request.method,
					error: {
						code: "REQUEST_CAPACITY_EXCEEDED",
						message: "Pi worker request capacity is full",
						retryable: true,
					},
				});
				return;
			}
			const controller = new AbortController();
			const active: ActiveHostRequest = {
				controller,
				cancelTimer: () => undefined,
			};
			activeHostRequests.set(request.requestId, active);
			active.cancelTimer = schedulePiWorkerDeadline(request.deadlineAt, () => {
				cancelHostRequest(request.requestId, active, new Error(`Pi worker request timed out: ${request.method}`));
			});
			if (controller.signal.aborted) return;
			const isCurrent = (): boolean =>
				activeHostRequests.get(request.requestId) === active && !controller.signal.aborted && !shuttingDown;
			const cancelCompletedLifecycle = async (): Promise<void> => {
				if (PI_WORKER_DOMAIN_METHODS.includes(request.method as PiWorkerDomainMethod)) return;
				try {
					await runtimeService.cancelCompletedLifecycle(request);
				} catch (error) {
					options.onFatal(toError(error));
				}
			};
			const operation = PI_WORKER_DOMAIN_METHODS.includes(request.method as PiWorkerDomainMethod)
				? domainService.handle(request, controller.signal)
				: runtimeService.handle(request, controller.signal);
			const settlement: Promise<void> = operation
				.then(
					async (result) => {
						if (!isCurrent() || Date.now() > request.deadlineAt) {
							await cancelCompletedLifecycle();
							return;
						}
						const delivered = await postResponse(
							{
								kind: "result",
								protocolVersion: PI_WORKER_PROTOCOL_VERSION,
								generation,
								requestId: request.requestId,
								method: request.method,
								result,
							},
							controller.signal,
						);
						if (!delivered) await cancelCompletedLifecycle();
					},
					async (error: unknown) => {
						if (!isCurrent()) return;
						await postResponse(
							{
								kind: "error",
								protocolVersion: PI_WORKER_PROTOCOL_VERSION,
								generation,
								requestId: request.requestId,
								method: request.method,
								error: piWorkerErrorDto(error),
							},
							controller.signal,
						);
					},
				)
				.finally(() => {
					releaseHostRequest(request.requestId, active);
					hostRequestSettlements.delete(settlement);
				});
			hostRequestSettlements.add(settlement);
			void settlement;
		};

		const handleCancel = (value: unknown): void => {
			const cancellation = parsePiWorkerCancel(value);
			if (cancellation.generation !== generation) return;
			if (cancellation.kind === "cancel") {
				const active = activeHostRequests.get(cancellation.requestId);
				if (active) cancelHostRequest(cancellation.requestId, active, new Error("Pi worker request was cancelled"));
				return;
			}
			const pending = pendingMainRequests.get(cancellation.requestId);
			if (!pending) return;
			pending.reject(new Error(`Main cancelled Pi worker request: ${pending.context.method}`));
		};

		let unlisten: (() => void) | null = null;
		const onClose = (): void => {
			if (!shuttingDown) options.onFatal(new Error("Pi worker control port closed"));
		};
		const shutdown = (): Promise<void> => {
			if (shutdownPromise) return shutdownPromise;
			shuttingDown = true;
			shutdownPromise = (async () => {
				for (const [requestId, request] of activeHostRequests) {
					cancelHostRequest(requestId, request, new Error("Pi worker is shutting down"));
				}
				const hostRequestResults = await Promise.allSettled([...hostRequestSettlements]);
				const domainDisposalResult = await Promise.allSettled([domainService.dispose()]);
				const runtimeDisposalResult = await Promise.allSettled([runtimeService.dispose()]);
				const extensionUiDisposalResult = await Promise.allSettled([extensionUi.dispose()]);
				extensionUiBridge.dispose();
				const failures = [
					...hostRequestResults,
					...domainDisposalResult,
					...runtimeDisposalResult,
					...extensionUiDisposalResult,
				].flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
				turnLifecycle.dispose();
				const modelDisposals = await Promise.allSettled([quotas.dispose(), modelRuntimes.dispose()]);
				for (const result of modelDisposals) if (result.status === "rejected") failures.push(result.reason);
				const settingsDisposal = await Promise.allSettled([settings.dispose()]);
				for (const result of settingsDisposal) if (result.status === "rejected") failures.push(result.reason);
				mainClosed = true;
				pendingMainRequests.rejectWhere(() => true, new Error("Pi worker is shutting down"));
				try {
					postPort(port, { kind: "shutdownComplete", protocolVersion: PI_WORKER_PROTOCOL_VERSION, generation });
					await port.drain?.();
				} catch (error) {
					failures.push(error);
				} finally {
					unlisten?.();
					port.off("close", onClose);
					try {
						port.close();
					} catch (error) {
						failures.push(error);
					}
				}
				throwAggregateFailures(failures, "Failed to dispose Pi worker services");
			})();
			return shutdownPromise;
		};

		startupShutdown = shutdown;
		unlisten = listenPort(port, (value) => {
			if (mainClosed) return;
			try {
				if (!value || typeof value !== "object" || !("kind" in value))
					throw new Error("Invalid Pi worker control frame");
				const kind = (value as { kind?: unknown }).kind;
				if (shuttingDown && kind !== "mainResult" && kind !== "mainError") return;
				if (kind === "request") handleRequest(value);
				else if (kind === "cancel" || kind === "mainCancel") handleCancel(value);
				else if (kind === "mainResult" || kind === "mainError") settleMainResponse(value);
				else if (kind === "shutdown") {
					const frame = parsePiWorkerShutdownFrame(value);
					if (frame.generation === generation) void shutdown().catch(options.onFatal);
				} else throw new Error(`Unexpected Pi worker control frame: ${String(kind)}`);
			} catch (error) {
				options.onFatal(toError(error));
			}
		});

		port.on("close", onClose);

		const { piVersion } = getAgentInfo();
		post({
			kind: "ready",
			protocolVersion: PI_WORKER_PROTOCOL_VERSION,
			generation,
			pid: process.pid,
			piVersion,
		});

		startupCleanups.length = 0;
		return { shutdown };
	} catch (error) {
		// Return the failing lifetime before reporting fatal, so the entry can drain it too.
		const shutdownStarted = startupShutdown?.();
		shuttingDown = true;
		const failedStartup = (async () => {
			const failures: unknown[] = [error];
			if (shutdownStarted) {
				try {
					await shutdownStarted;
				} catch (cleanupError) {
					failures.push(cleanupError);
				}
			} else {
				for (const cleanup of startupCleanups.reverse()) {
					try {
						await cleanup();
					} catch (cleanupError) {
						failures.push(cleanupError);
					}
				}
				try {
					port.close();
				} catch (cleanupError) {
					failures.push(cleanupError);
				}
			}
			startupCleanups.length = 0;
			throwAggregateFailures(failures, "Failed to start Pi worker and release its services");
		})();
		void failedStartup.catch((failure: unknown) => options.onFatal(toError(failure)));
		return { shutdown: () => failedStartup };
	}
}
