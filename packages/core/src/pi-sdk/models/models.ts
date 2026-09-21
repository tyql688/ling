import type { PiProjectModelAccess } from "./model-project-access";
import type { PiModelsConfig } from "./models-config";
import type { PiModelRuntimes } from "./model-runtime";
import type { PiModelCatalog } from "./model-catalog";
import { type PiModelCredentials, loginWithProvider } from "./model-credentials";
import type { PiModelProviderMutations } from "./model-provider-mutations";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
	type AddCustomModelRequest,
	type AddCustomProviderRequest,
	MODEL_LOGIN_RESPONSE_MAX_CHARS,
	type ModelCatalogRefreshResult,
	type ModelLoginEvent,
	type ProviderCatalog,
	type UpdateCustomModelRequest,
	type UpdateCustomProviderRequest,
} from "@ling/contracts/model";
import { errorMessage } from "@ling/contracts/ling-error";
import { requestCancelled } from "../../ling-error";
import { createLogger } from "../../logger";
import { assertSafeRegistryKey } from "./models-config-format";

const log = createLogger("model-auth");

const MODEL_LOGIN_EVENT_LIST_MAX_ITEMS = 256;
const MODEL_LOGIN_EVENT_LINK_MAX_ITEMS = 64;

type PiAuthInteraction = Parameters<ModelRuntime["login"]>[2];
type PiAuthPrompt = Parameters<PiAuthInteraction["prompt"]>[0];
type PiAuthEvent = Parameters<PiAuthInteraction["notify"]>[0];
type PiAuthMethod = Parameters<ModelRuntime["login"]>[1];
/** Model catalog refresh total timeout; 15s covers slow provider listing, anything longer stalls settings/model switching. */
const MODEL_CATALOG_REFRESH_TIMEOUT_MS = 15_000;

function assertLoginEventText(value: unknown, label: string): asserts value is string {
	if (typeof value !== "string" || value.length > MODEL_LOGIN_RESPONSE_MAX_CHARS) {
		throw new Error(`${label} is too large`);
	}
}

function shutdownCancellationError() {
	return requestCancelled("The model configuration update was cancelled because Ling is shutting down.");
}

interface PendingReply {
	resolve: (value: string) => void;
	reject: (error: Error) => void;
}

interface ActiveLogin {
	flowId: string;
	provider: string;
	cwd: string | null;
	controller: AbortController;
	pending: Map<string, PendingReply>;
	nextRequestId: number;
}

export function createPiModels({
	projects,
	modelRuntimes,
	config,
	catalog,
	credentials,
	providerMutations,
}: {
	projects: PiProjectModelAccess;
	modelRuntimes: PiModelRuntimes;
	config: PiModelsConfig;
	catalog: PiModelCatalog;
	credentials: PiModelCredentials;
	providerMutations: PiModelProviderMutations;
}) {
	const { withOpenProject } = projects;
	const { getGlobalModelRuntime } = modelRuntimes;
	const { refreshModelRuntime, reloadGlobalModelRuntime } = config;
	const { listProvidersNow } = catalog;
	const { removeProjectProviderAuthMutation, removeProviderAuthMutation, setProviderApiKeyMutation } = credentials;
	const {
		addCustomModelMutation,
		adoptCatalogModelsMutation,
		addCustomProviderMutation,
		removeCustomModelMutation,
		removeCustomProviderMutation,
		updateCustomModelMutation,
		updateCustomProviderMutation,
	} = providerMutations;

	let mutationTail: Promise<void> = Promise.resolve();
	let activeCatalogRefresh: { controller: AbortController; settlement: Promise<void> } | null = null;
	let shutdownPromise: Promise<void> | null = null;
	let shuttingDown = false;
	let pendingMutationCount = 0;

	function enqueueModelMutation<Result>(mutate: () => Promise<Result>): Promise<Result> {
		if (shuttingDown) return Promise.reject(shutdownCancellationError());
		pendingMutationCount += 1;
		const operation = mutationTail.then(mutate);
		mutationTail = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation.finally(() => {
			pendingMutationCount -= 1;
		});
	}

	/**
	 * models.json shapes as Pi's ModelConfig schema defines them.
	 * Unknown keys (headers/compat/modelOverrides/…) ride along untyped so a read-modify-write
	 * never drops configuration Ling doesn't manage. Pi treats line comments and trailing
	 * commas as syntax only; a Ling mutation normalizes the document to strict JSON while
	 * preserving every parsed key/value it does not own.
	 */

	function addCustomProvider(request: AddCustomProviderRequest): Promise<void> {
		return enqueueModelMutation(() => addCustomProviderMutation(request));
	}

	function addCustomModel(request: AddCustomModelRequest): Promise<void> {
		return enqueueModelMutation(() => addCustomModelMutation(request));
	}

	function removeCustomModel(provider: string, modelId: string): Promise<void> {
		return enqueueModelMutation(() => removeCustomModelMutation(provider, modelId));
	}

	function removeCustomProvider(provider: string): Promise<void> {
		return enqueueModelMutation(() => removeCustomProviderMutation(provider));
	}

	function updateCustomProvider(request: UpdateCustomProviderRequest): Promise<void> {
		return enqueueModelMutation(() => updateCustomProviderMutation(request));
	}

	function updateCustomModel(request: UpdateCustomModelRequest): Promise<void> {
		return enqueueModelMutation(() => updateCustomModelMutation(request));
	}

	function setProviderApiKey(provider: string, key: string): Promise<void> {
		return enqueueModelMutation(() => setProviderApiKeyMutation(provider, key));
	}

	function removeProviderAuth(provider: string): Promise<void> {
		return enqueueModelMutation(() => removeProviderAuthMutation(provider));
	}

	function removeProjectProviderAuth(cwd: string, provider: string): Promise<void> {
		return enqueueModelMutation(() => removeProjectProviderAuthMutation(cwd, provider));
	}

	/** Only one interactive provider-auth flow can run at a time — it owns the login dialog. */
	let activeLogin: ActiveLogin | null = null;

	/**
	 * Runs Pi's provider-owned login flow, translating its neutral interaction protocol into
	 * ModelLoginEvents for the renderer. Never rejects after the flow starts: success and
	 * failure are both reported through a final `{ type: "done" }` event so the dialog is
	 * the single place that renders outcomes.
	 *
	 * `openUrl` is injected by the host adapter, which forwards the validated URL to Main,
	 * so this module stays shell-agnostic at the Core boundary.
	 */
	async function runLogin(
		flowId: string,
		provider: string,
		method: PiAuthMethod,
		cwd: string | null,
		emit: (event: ModelLoginEvent) => void,
		openUrl: (url: string) => void,
	): Promise<void> {
		assertSafeRegistryKey(provider, "Provider id");
		const login: ActiveLogin = {
			flowId,
			provider,
			cwd,
			controller: new AbortController(),
			pending: new Map(),
			nextRequestId: 1,
		};
		activeLogin = login;

		function ask(prompt: PiAuthPrompt): Promise<string> {
			const requestId = `${flowId}-${login.nextRequestId++}`;
			let event: ModelLoginEvent;
			assertLoginEventText(prompt.message, "Model login prompt message");
			switch (prompt.type) {
				case "text":
				case "secret":
					if (prompt.placeholder !== undefined) {
						assertLoginEventText(prompt.placeholder, "Model login prompt placeholder");
					}
					event = {
						type: "prompt",
						requestId,
						message: prompt.message,
						placeholder: prompt.placeholder ?? null,
						secret: prompt.type === "secret",
					};
					break;
				case "manual_code":
					if (prompt.placeholder !== undefined) {
						assertLoginEventText(prompt.placeholder, "Model login prompt placeholder");
					}
					event = {
						type: "manual-code",
						requestId,
						message: prompt.message,
						placeholder: prompt.placeholder ?? null,
					};
					break;
				case "select":
					if (!Array.isArray(prompt.options) || prompt.options.length > MODEL_LOGIN_EVENT_LIST_MAX_ITEMS) {
						throw new Error("Model login prompt option count is too large");
					}
					for (const option of prompt.options) {
						assertLoginEventText(option.id, "Model login option id");
						assertLoginEventText(option.label, "Model login option label");
						if (option.description !== undefined) {
							assertLoginEventText(option.description, "Model login option description");
						}
					}
					event = {
						type: "select",
						requestId,
						message: prompt.message,
						options: prompt.options.map((option) => ({
							id: option.id,
							label: option.label,
							description: option.description ?? null,
						})),
					};
					break;
			}
			return new Promise<string>((resolve, reject) => {
				let onAbort: (() => void) | null = null;
				const cleanup = () => {
					if (onAbort && prompt.signal) prompt.signal.removeEventListener("abort", onAbort);
					onAbort = null;
				};
				const reply: PendingReply = {
					resolve: (value) => {
						cleanup();
						resolve(value);
					},
					reject: (error) => {
						cleanup();
						reject(error);
					},
				};
				if (prompt.signal?.aborted) {
					reply.reject(new Error("Login prompt cancelled"));
					return;
				}
				login.pending.set(requestId, reply);
				if (prompt.signal) {
					onAbort = () => {
						if (!login.pending.delete(requestId)) return;
						emit({ type: "request-cancelled", requestId });
						reply.reject(new Error("Login prompt cancelled"));
					};
					prompt.signal.addEventListener("abort", onAbort, { once: true });
					if (prompt.signal.aborted) {
						onAbort();
						return;
					}
				}
				emit(event);
			});
		}

		function notify(event: PiAuthEvent): void {
			switch (event.type) {
				case "auth_url":
					assertLoginEventText(event.url, "Model login URL");
					if (event.instructions !== undefined) {
						assertLoginEventText(event.instructions, "Model login instructions");
					}
					openUrl(event.url);
					emit({
						type: "auth-url",
						url: event.url,
						instructions: event.instructions ?? null,
					});
					break;
				case "device_code":
					assertLoginEventText(event.userCode, "Model login device code");
					assertLoginEventText(event.verificationUri, "Model login verification URL");
					emit({
						type: "device-code",
						userCode: event.userCode,
						verificationUri: event.verificationUri,
					});
					break;
				case "info":
					assertLoginEventText(event.message, "Model login information");
					if ((event.links?.length ?? 0) > MODEL_LOGIN_EVENT_LINK_MAX_ITEMS) {
						throw new Error("Model login link count is too large");
					}
					for (const link of event.links ?? []) {
						assertLoginEventText(link.url, "Model login link URL");
						if (link.label !== undefined) assertLoginEventText(link.label, "Model login link label");
					}
					emit({
						type: "info",
						message: event.message,
						links: (event.links ?? []).map((link) => ({ url: link.url, label: link.label ?? null })),
					});
					break;
				case "progress":
					assertLoginEventText(event.message, "Model login progress");
					emit({ type: "progress", message: event.message });
					break;
			}
		}

		try {
			const interaction: PiAuthInteraction = {
				signal: login.controller.signal,
				prompt: ask,
				notify,
			};
			let synchronization: Awaited<ReturnType<typeof loginWithProvider>>;
			if (cwd === null) {
				const runtime = await getGlobalModelRuntime();
				synchronization = await loginWithProvider(runtime, provider, method, interaction, async () => {
					await reloadGlobalModelRuntime(login.controller.signal);
				});
			} else {
				synchronization = await withOpenProject(cwd, async (services) =>
					loginWithProvider(services.modelRuntime, provider, method, interaction, async () => {
						await refreshModelRuntime(services.modelRuntime, {
							allowNetwork: false,
							signal: login.controller.signal,
						});
					}),
				);
			}
			log.info(`${method} login completed for ${provider}${cwd === null ? "" : ` in ${cwd}`}`);
			emit({
				type: "done",
				ok: true,
				error: synchronization.error,
				credentialSynchronization: synchronization.state,
			});
		} catch (error) {
			const message = errorMessage(error).slice(0, MODEL_LOGIN_RESPONSE_MAX_CHARS);
			log.error(`${method} login failed for ${provider}:`, error);
			emit({ type: "done", ok: false, error: message, credentialSynchronization: null });
		} finally {
			// Settle whatever the flow left hanging (e.g. the optional manual-code input that
			// raced a completed callback server — the SDK .catch()es these rejections).
			for (const reply of login.pending.values()) reply.reject(new Error("Login flow ended"));
			login.pending.clear();
			if (activeLogin === login) activeLogin = null;
		}
	}

	/** Provider listing reloads the profile ModelRuntime and therefore participates in
	 * the same serialization domain as config writes, login, and network catalog refresh. */
	function listProviders(): Promise<ProviderCatalog> {
		return enqueueModelMutation(listProvidersNow);
	}

	/** Rebuilds the credential-dependent model snapshot from canonical auth.json after
	 * a committed SDK login reported incomplete local synchronization. This is a second,
	 * serialized recovery pass used only before the UI upgrades `pending` to `recovered`. */
	function reconcileProviderCredentialRuntime(cwd: string | null): Promise<void> {
		return enqueueModelMutation(async () => {
			if (cwd === null) {
				await reloadGlobalModelRuntime();
				return;
			}
			await withOpenProject(cwd, async (services) => {
				await refreshModelRuntime(services.modelRuntime, { allowNetwork: false });
			});
		});
	}

	function startLogin(
		flowId: string,
		provider: string,
		method: PiAuthMethod,
		cwd: string | null,
		emit: (event: ModelLoginEvent) => void,
		openUrl: (url: string) => void,
	): Promise<void> {
		if (shuttingDown) return Promise.reject(shutdownCancellationError());
		if (pendingMutationCount > 0) return Promise.reject(new Error("A model configuration update is in progress"));
		if (activeLogin) return Promise.reject(new Error(`A login for ${activeLogin.provider} is already in progress`));
		if (activeCatalogRefresh) return Promise.reject(new Error("A model catalog refresh is in progress"));
		const operation = runLogin(flowId, provider, method, cwd, emit, openUrl);
		const settlement = operation.then(
			() => undefined,
			() => undefined,
		);
		mutationTail = settlement;
		return operation;
	}

	function respondLogin(flowId: string, requestId: string, value: string | null): void {
		if (!activeLogin) throw new Error("No login in progress");
		if (activeLogin.flowId !== flowId) throw new Error("The login flow is no longer active");
		const reply = activeLogin.pending.get(requestId);
		if (!reply) throw new Error(`Unknown login request: ${requestId}`);
		activeLogin.pending.delete(requestId);
		if (value === null) {
			reply.reject(new Error("Login prompt dismissed"));
		} else {
			reply.resolve(value);
		}
	}

	function cancelActiveLogin(): void {
		if (!activeLogin) return;
		log.info(`login cancelled for ${activeLogin.provider}`);
		activeLogin.controller.abort();
		for (const reply of activeLogin.pending.values()) reply.reject(new Error("Login cancelled"));
		activeLogin.pending.clear();
	}

	/** A stale dialog cancellation is intentionally a no-op: it must never abort the
	 * provider flow owned by the currently mounted dialog. */
	function cancelLogin(flowId: string): void {
		if (activeLogin?.flowId !== flowId) return;
		cancelActiveLogin();
	}

	function refreshModelCatalogs(signal?: AbortSignal): Promise<ModelCatalogRefreshResult> {
		if (shuttingDown) return Promise.reject(shutdownCancellationError());
		if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Model catalog refresh was cancelled"));
		if (pendingMutationCount > 0) return Promise.reject(new Error("A model configuration update is in progress"));
		if (activeLogin) return Promise.reject(new Error(`A login for ${activeLogin.provider} is in progress`));
		if (activeCatalogRefresh) return Promise.reject(new Error("A model catalog refresh is already in progress"));

		const controller = new AbortController();
		const onAbort = (): void => controller.abort(signal?.reason);
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) onAbort();
		let timedOut = false;
		const timeout = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, MODEL_CATALOG_REFRESH_TIMEOUT_MS);
		const operation = getGlobalModelRuntime().then(async (runtime) => {
			const result = await refreshModelRuntime(runtime, {
				allowNetwork: true,
				force: true,
				signal: controller.signal,
			});
			const adoption =
				result.aborted || controller.signal.aborted
					? { adoptedModels: [], backupPath: null, errors: [] }
					: await adoptCatalogModelsMutation(new Set(result.errors.keys()), controller.signal);
			return {
				aborted: result.aborted || controller.signal.aborted,
				timedOut,
				...adoption,
				errors: [...result.errors]
					.map(([provider, error]) => ({ provider, message: error.message }))
					.concat(adoption.errors),
			};
		});
		const settlement = operation.then(
			() => undefined,
			() => undefined,
		);
		activeCatalogRefresh = { controller, settlement };
		// Model/config mutations admitted while a refresh is running queue behind its
		// settlement instead of racing provider recomposition and snapshot publication.
		mutationTail = settlement;
		void settlement.finally(() => {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", onAbort);
			if (activeCatalogRefresh?.settlement === settlement) activeCatalogRefresh = null;
		});
		return operation;
	}

	function cancelModelCatalogRefresh(): void {
		if (!activeCatalogRefresh) return;
		log.info("model catalog refresh cancelled");
		activeCatalogRefresh.controller.abort();
	}

	/** Stops model/auth writes, cancels interactive login, and drains every operation
	 * admitted before application shutdown. The application coordinator owns the deadline. */
	function shutdownModelOperations(): Promise<void> {
		if (shutdownPromise) return shutdownPromise;
		shuttingDown = true;
		cancelActiveLogin();
		cancelModelCatalogRefresh();
		// Login and catalog-refresh settlements both become mutationTail; later writes
		// queue behind that same promise, so one drain covers every admitted operation.
		shutdownPromise = mutationTail;
		return shutdownPromise;
	}
	return {
		addCustomProvider,
		addCustomModel,
		removeCustomModel,
		removeCustomProvider,
		updateCustomProvider,
		updateCustomModel,
		setProviderApiKey,
		removeProviderAuth,
		removeProjectProviderAuth,
		listProviders,
		reconcileProviderCredentialRuntime,
		startLogin,
		respondLogin,
		cancelLogin,
		refreshModelCatalogs,
		cancelModelCatalogRefresh,
		shutdownModelOperations,
	};
}

export type PiModels = ReturnType<typeof createPiModels>;
