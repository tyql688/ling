import type { ModelLoginEvent, ModelLoginEventEnvelope } from "@ling/contracts/model";
import { modelsProcedures } from "@ling/contracts/model-procedures";
import type { HostDomain, HostHandlers } from "../../transport/host-domain";

import { requestCancelled, requestCapacityExceeded, toError } from "@ling/core/ling-error";
import { createLogger } from "@ling/core/logger";
import type { ProjectAccess } from "@ling/host/runtime/project-access";
import {
	piResourceReloadError,
	piResourceReloadFailed,
	type ResourceReloadCoordinator,
} from "@ling/host/domains/resources/resource-reload";
import type { HostEventPublisher } from "@ling/host/transport/event-bus";
import type { PiWorkerClient } from "@ling/host/workers/pi/pi-worker-client";

const log = createLogger("model-ipc");

export function createModelDomain({
	piWorker,
	resources,
	projectOperations,
	events,
}: {
	piWorker: PiWorkerClient;
	resources: ResourceReloadCoordinator;
	projectOperations: ProjectAccess;
	events: HostEventPublisher;
}): HostDomain {
	const { reloadPiResources, mutateThenReloadPiResources } = resources;
	const { resolveKnownOpenProjectPath } = projectOperations;

	type ActiveLogin = {
		clientId: string;
		terminal: Extract<ModelLoginEvent, { type: "done" }> | null;
		admission: AbortController;
	};
	const activeLoginEvents = new Map<string, ActiveLogin>();
	const activeNetworkOperations = new Set<Promise<unknown>>();
	let disposed = false;
	const runNetworkOperation = <Result>(operation: () => Promise<Result>): Promise<Result> => {
		const work = Promise.resolve().then(() => {
			if (disposed) throw requestCancelled("Model handlers are shutting down");
			return operation();
		});
		const tracked: Promise<Result> = work.finally(() => activeNetworkOperations.delete(tracked));
		activeNetworkOperations.add(tracked);
		return tracked;
	};
	const broadcastChanged = () => events.broadcast(modelsProcedures.onChanged.channel, null);
	const unsubscribeCatalogChanged = piWorker.onModelCatalogChanged(broadcastChanged);
	const unsubscribeLoginEvents = piWorker.onModelLoginEvent((flowId, event) => {
		const active = activeLoginEvents.get(flowId);
		if (!active) return;
		if (event.type === "done") active.terminal = event;
		else {
			events.send(active.clientId, modelsProcedures.onLoginEvent.channel, {
				flowId,
				event,
			} satisfies ModelLoginEventEnvelope);
		}
	});
	const unsubscribeModelOpenExternal = piWorker.onModelOpenExternal((flowId, url) => {
		const active = activeLoginEvents.get(flowId);
		if (!active) return;
		events.send(active.clientId, modelsProcedures.onOpenExternal.channel, url);
	});
	const reloadChangedModels = async (label: string): Promise<unknown> => {
		const outcome = `${label} was saved`;
		try {
			const summary = await reloadPiResources();
			const failure = piResourceReloadError(summary, `${outcome}, but one or more live Pi resources could not reload.`);
			if (failure) {
				log.error(`${outcome}, but live Pi resource reconciliation was incomplete:`, summary);
			}
			return failure;
		} catch (error) {
			log.error(`${outcome}, but live Pi resource reconciliation failed:`, error);
			return error;
		}
	};
	const mutateChangedModels = async (label: string, mutate: () => Promise<void>): Promise<void> => {
		const bothFailedMessage = `${label} mutation and Pi resource reconciliation both failed`;
		// A models.json/auth.json publication can succeed before the profile runtime
		// refresh reports an error. Reconcile every admitted mutation and retain both
		// failures when the canonical mutation and live-resource repair both fail.
		const { mutation, reload } = await mutateThenReloadPiResources(bothFailedMessage, mutate);
		const outcome = mutation.failed ? `${label} mutation failed` : `${label} was saved`;
		const reloadError = piResourceReloadError(
			reload,
			`${outcome}, but one or more live Pi resources could not reload.`,
		);
		if (reloadError) log.error(`${outcome}, but live Pi resource reconciliation was incomplete:`, reload);
		if (mutation.failed && reloadError) throw new AggregateError([mutation.error, reloadError], bothFailedMessage);
		if (mutation.failed) throw mutation.error;
		if (reloadError) throw reloadError;
	};
	const handlers: HostHandlers = {
		[modelsProcedures.listProviders.channel]: async () => piWorker.listProviders(),

		[modelsProcedures.getConfiguration.channel]: async (_event, value) => {
			return piWorker.getModelConfiguration({
				...value,
				cwd: value.cwd === null ? null : resolveKnownOpenProjectPath(value.cwd),
			});
		},

		[modelsProcedures.listProjectModels.channel]: async (_event, value) => {
			return piWorker.listProjectModels(resolveKnownOpenProjectPath(value.cwd));
		},

		[modelsProcedures.getApiKey.channel]: async (_event, value) => {
			return piWorker.getApiKey({
				...value,
				cwd: value.cwd === null ? null : resolveKnownOpenProjectPath(value.cwd),
			});
		},

		[modelsProcedures.setApiKey.channel]: async (_event, value) => {
			await mutateChangedModels("The API key", () => piWorker.setApiKey(value.provider, value.key));
		},

		[modelsProcedures.removeAuth.channel]: async (_event, value) => {
			await mutateChangedModels("The credential removal", () =>
				piWorker.removeAuth({
					...value,
					cwd: value.cwd === null ? null : resolveKnownOpenProjectPath(value.cwd),
				}),
			);
		},

		[modelsProcedures.addProvider.channel]: async (_event, value) => {
			await mutateChangedModels("The provider", () => piWorker.addProvider(value));
		},

		[modelsProcedures.addModel.channel]: async (_event, value) => {
			await mutateChangedModels("The model", () => piWorker.addModel(value));
		},

		[modelsProcedures.removeModel.channel]: async (_event, value) => {
			await mutateChangedModels("The model removal", () => piWorker.removeModel(value.provider, value.modelId));
		},

		[modelsProcedures.removeProvider.channel]: async (_event, value) => {
			await mutateChangedModels("The provider removal", () => piWorker.removeProvider(value));
		},

		[modelsProcedures.probeProvider.channel]: async (_event, value) => {
			return runNetworkOperation(() => piWorker.probeProvider(value.baseUrl, value.apiKey));
		},

		[modelsProcedures.updateProvider.channel]: async (_event, value) => {
			await mutateChangedModels("The provider", () => piWorker.updateProvider(value));
		},

		[modelsProcedures.updateModel.channel]: async (_event, value) => {
			await mutateChangedModels("The model", () => piWorker.updateModel(value));
		},

		[modelsProcedures.refreshCatalogs.channel]: async () =>
			runNetworkOperation(async () => {
				let result: Awaited<ReturnType<typeof piWorker.refreshModelCatalogs>>;
				try {
					result = await piWorker.refreshModelCatalogs();
				} catch (refreshError) {
					// Successful providers may already have published partial updates, while
					// failed providers retain their previous catalog. Reconcile both states and
					// retain both failures when that repair also fails.
					const reloadError = await reloadChangedModels("The model catalog");
					if (reloadError) {
						throw new AggregateError(
							[refreshError, reloadError],
							"Model catalog refresh and Pi resource reconciliation both failed",
						);
					}
					throw refreshError;
				}
				const reloadError = await reloadChangedModels("The model catalog");
				if (reloadError) throw toError(reloadError);
				return result;
			}),

		[modelsProcedures.cancelCatalogRefresh.channel]: async () => piWorker.cancelModelCatalogRefresh(),

		[modelsProcedures.loginStart.channel]: async (context, value) => {
			if (activeLoginEvents.has(value.flowId)) {
				throw requestCapacityExceeded("modelLoginFlow", 1, "The model login is already active");
			}
			if (disposed) throw requestCancelled("Model handlers are shutting down");
			try {
				const sendLoginEvent = (event: ModelLoginEvent) => {
					events.send(context.clientId, modelsProcedures.onLoginEvent.channel, {
						flowId: value.flowId,
						event,
					} satisfies ModelLoginEventEnvelope);
				};
				const loginResult: ActiveLogin = {
					clientId: context.clientId,
					terminal: null,
					admission: new AbortController(),
				};
				activeLoginEvents.set(value.flowId, loginResult);
				const loginCwd = value.cwd === null ? null : resolveKnownOpenProjectPath(value.cwd);
				let startError: unknown = null;
				try {
					await piWorker.startLogin(value.flowId, value.provider, value.method, loginCwd, loginResult.admission.signal);
				} catch (error) {
					startError = error;
				}
				if (disposed) return;
				const terminalEvent = loginResult.terminal;
				if (!terminalEvent) {
					// Cancellation before Pi admission has no provider flow or terminal event to reconcile.
					if (loginResult.admission.signal.aborted && startError === loginResult.admission.signal.reason) return;
					if (startError !== null) throw toError(startError);
					throw new Error("The model login ended without a terminal result");
				}
				if (startError !== null) {
					// The ordered terminal event proves the provider flow settled even if the
					// worker response was lost while the Host was shutting down.
					log.error("Model login settled before its Pi worker response was lost:", startError);
				}
				// A provider can persist credentials and then fail while refreshing its
				// runtime. Reconcile every completed provider flow, including a failed
				// terminal event, while preserving that original terminal result.
				const loginOutcome = terminalEvent.ok ? "Login succeeded" : "Login failed";
				let reloadWarning = false;
				try {
					const summary = await reloadPiResources();
					reloadWarning = piResourceReloadFailed(summary);
					if (reloadWarning) {
						log.error(`${loginOutcome}, but live Pi resource reconciliation was incomplete:`, summary);
					}
				} catch (error) {
					reloadWarning = true;
					log.error(`${loginOutcome}, but live Pi resource reconciliation failed:`, error);
				}
				if (reloadWarning) {
					sendLoginEvent({
						type: "info",
						message: terminalEvent.ok
							? "Credentials were saved, but one or more live sessions could not reload."
							: "Login failed, and Ling could not fully reconcile credentials with one or more live sessions.",
						links: [],
					});
				}
				let recoveredPendingCredential = false;
				if (terminalEvent.ok && terminalEvent.credentialSynchronization === "pending" && !reloadWarning) {
					try {
						await piWorker.reconcileCredential(loginCwd);
						recoveredPendingCredential = true;
						broadcastChanged();
					} catch (error) {
						log.error("Credentials were saved, but the final model-runtime recovery failed:", error);
					}
				}
				sendLoginEvent(
					recoveredPendingCredential
						? { ...terminalEvent, error: null, credentialSynchronization: "recovered" }
						: terminalEvent,
				);
			} finally {
				activeLoginEvents.delete(value.flowId);
			}
		},

		[modelsProcedures.loginRespond.channel]: async (_event, value) => {
			await piWorker.respondLogin(value.flowId, value.requestId, value.value);
		},

		[modelsProcedures.loginCancel.channel]: async (_event, value) => {
			activeLoginEvents.get(value.flowId)?.admission.abort();
			await piWorker.cancelLogin(value.flowId);
		},
	};
	return {
		handlers,
		prepareShutdown: () => {
			if (disposed) return;
			disposed = true;
			unsubscribeCatalogChanged();
			unsubscribeLoginEvents();
			unsubscribeModelOpenExternal();
			for (const [flowId, login] of activeLoginEvents) {
				login.admission.abort();
				void piWorker.cancelLogin(flowId).catch((error: unknown) => {
					log.error(`Failed to cancel model login ${flowId} during shutdown:`, error);
				});
			}
			activeLoginEvents.clear();
		},
	};
}
