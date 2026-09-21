import type { PiModelRuntimes } from "./model-runtime";
import {
	type PiModelsConfig,
	throwMutationFailures,
	type ModelsConfigMutation,
	type StoredCredentialSnapshot,
} from "./models-config";
import type { PiModelCredentials } from "./model-credentials";
import {
	type AddCustomModelRequest,
	type AddCustomProviderRequest,
	type ModelCatalogRefreshResult,
	type UpdateCustomModelRequest,
	type UpdateCustomProviderRequest,
	CUSTOM_PROVIDER_APIS,
	modelOptionsSchema,
} from "@ling/contracts/model";
import { writeTextFileAtomic } from "@ling/core/store/atomic-file-store";
import { isDeepStrictEqual } from "node:util";
import { createLogger } from "../../logger";
import { throwIfOperationAborted } from "../../ling-error";
import type { PiStoredCredentialMutation, PiStoredCredentialMutationObserver } from "./credential-store";
import { readCatalogModelSource } from "./catalog-model-source";
import {
	type ModelsJsonProvider,
	assertSafeRegistryKey,
	type ModelsJsonConfig,
	ownProviderEntry,
	type ModelsJsonModel,
} from "./models-config-format";

const log = createLogger("model-config");

/** Custom provider id shape; starts with a lowercase letter or digit, aligned with path/key safety boundaries. */
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

function normalizeHttpBaseUrl(value: string): string {
	const baseUrl = value.trim();
	if (!baseUrl) throw new Error("Base URL must not be empty");
	let protocol: string;
	try {
		protocol = new URL(baseUrl).protocol;
	} catch {
		throw new Error("Base URL must be an http:// or https:// URL");
	}
	if (protocol !== "http:" && protocol !== "https:") {
		throw new Error("Base URL must be an http:// or https:// URL");
	}
	return baseUrl;
}

function normalizeNullableName(value: string | null): string | undefined {
	const name = value?.trim();
	return name ? name : undefined;
}

function assertNullablePositiveSafeInteger(value: number | null, label: string): void {
	if (value !== null && (!Number.isSafeInteger(value) || value <= 0)) throw new Error(`Invalid ${label}`);
}

function applyOpenAiCompletionsCompatibility(provider: ModelsJsonProvider): void {
	if (provider.api !== "openai-completions") return;
	const compat = provider.compat;
	if (compat === undefined) {
		provider.compat = { supportsDeveloperRole: false };
		return;
	}
	// Preserve an explicit user choice and every Pi/vendor compatibility field. The
	// safe default is added only when compat is a normal object that omitted it;
	// malformed external input stays untouched so ModelRuntime validation can reject it.
	if (typeof compat === "object" && compat !== null && !Array.isArray(compat)) {
		const record = compat as Record<string, unknown>;
		if (!Object.hasOwn(record, "supportsDeveloperRole")) record.supportsDeveloperRole = false;
	}
}

function requireCustomProviderEntry(
	config: ModelsJsonConfig,
	provider: string,
	builtIns: ReadonlySet<string>,
): ModelsJsonProvider {
	assertSafeRegistryKey(provider, "Provider id");
	const entry = ownProviderEntry(config.providers, provider);
	if (!entry) throw new Error(`Provider "${provider}" is not defined in models.json`);
	if (builtIns.has(provider))
		throw new Error(`Provider "${provider}" is built-in — edit models.json directly for overrides`);
	return entry;
}

/** Built-in providers can own custom models without becoming editable/deletable custom providers. */
function requireModelProviderEntry(
	config: ModelsJsonConfig,
	provider: string,
	builtIns: ReadonlySet<string>,
): ModelsJsonProvider {
	assertSafeRegistryKey(provider, "Provider id");
	const entry = ownProviderEntry(config.providers, provider);
	if (entry) return entry;
	if (!builtIns.has(provider)) throw new Error(`Provider "${provider}" is not defined in models.json`);
	const created: ModelsJsonProvider = {};
	config.providers[provider] = created;
	return created;
}

export function createPiModelProviderMutations({
	modelRuntimes,
	config,
	credentials,
	agentDir,
}: {
	modelRuntimes: PiModelRuntimes;
	config: PiModelsConfig;
	credentials: PiModelCredentials;
	agentDir: string;
}) {
	const { deleteStoredProfileCredentialSnapshot, getGlobalModelRuntime } = modelRuntimes;
	const {
		modelsConfigStore,
		getBuiltInProviderIds,
		mutateModelsConfigAndReload,
		commitModelsConfigMutation,
		reloadGlobalModelRuntimeForMutation,
		assertModelsConfigMutationCurrent,
		restoreModelsConfigMutation,
		restoreCredentialForModelsRollback,
		reloadCurrentModelRuntimeAfterFailure,
		assertModelsConfigMutationCurrentSync,
	} = config;
	const { storeDirectApiKey } = credentials;

	/** Updating the catalog transfers matching custom definitions back to Pi. The
	 * provider connection/auth configuration remains user-owned, as do other IDs.
	 * Pure modelOverrides on existing official models remain explicit user overrides;
	 * overrides attached to an adopted custom definition are removed with it. */
	async function adoptCatalogModelsMutation(
		failedProviders: ReadonlySet<string>,
		signal: AbortSignal,
	): Promise<Pick<ModelCatalogRefreshResult, "adoptedModels" | "backupPath" | "errors">> {
		const initial = await modelsConfigStore.read({ signal });
		const builtIns = await getBuiltInProviderIds();
		const providers = Object.entries(initial.providers)
			.filter(
				([id, entry]) =>
					builtIns.has(id) && !failedProviders.has(id) && entry.models !== undefined && entry.models.length > 0,
			)
			.map(([id]) => id);
		if (providers.length === 0) return { adoptedModels: [], backupPath: null, errors: [] };
		const official = await readCatalogModelSource(agentDir, providers, signal);
		const inspectedProviders = new Set(providers.filter((provider) => !official.errors.has(provider)));
		let backupPath: string | null = null;
		const adoptedModels = await mutateModelsConfigAndReload(
			"adopt models from the updated catalog",
			(config) => {
				throwIfOperationAborted(signal);
				const adopted: ModelCatalogRefreshResult["adoptedModels"] = [];
				for (const [provider, entry] of Object.entries(config.providers)) {
					if (!inspectedProviders.has(provider) || entry.models === undefined) continue;
					const remaining = entry.models.filter((model) => {
						if (official.runtime.getModel(provider, model.id) === undefined) return true;
						adopted.push({ provider, modelId: model.id });
						if (entry.modelOverrides !== undefined) delete entry.modelOverrides[model.id];
						return false;
					});
					if (remaining.length === entry.models.length) continue;
					if (remaining.length > 0) entry.models = remaining;
					else delete entry.models;
					if (entry.modelOverrides !== undefined && Object.keys(entry.modelOverrides).length === 0)
						delete entry.modelOverrides;
					if (Object.keys(entry).length === 0) delete config.providers[provider];
					else if (
						remaining.length === 0 &&
						!entry.baseUrl &&
						!entry.headers &&
						!entry.compat &&
						!entry.modelOverrides &&
						!entry.apiKey &&
						!entry.oauth &&
						entry.authHeader === undefined
					) {
						// Pi needs an operational override even when only a display name or
						// unknown metadata remains. Empty compatibility changes no behavior.
						entry.compat = {};
					}
				}
				return adopted;
			},
			async (source, targetPath) => {
				throwIfOperationAborted(signal);
				// Retain one exact snapshot, bounded by the models.json read limit. A
				// failed backup prevents the automatic replacement from being published.
				backupPath = `${targetPath}.before-catalog-update.bak`;
				await writeTextFileAtomic(backupPath, source);
				throwIfOperationAborted(signal);
			},
		);
		return {
			adoptedModels,
			backupPath,
			errors: [...official.errors].map(([provider, error]) => ({ provider, message: error.message })),
		};
	}

	async function addCustomProviderMutation(request: AddCustomProviderRequest): Promise<void> {
		const id = request.id.trim();
		assertSafeRegistryKey(id, "Provider id");
		const name = normalizeNullableName(request.name);
		const baseUrl = normalizeHttpBaseUrl(request.baseUrl);
		const apiKey = request.apiKey === null ? null : request.apiKey.trim();
		const attemptedCredential = apiKey === null ? null : ({ type: "api_key", key: apiKey } as const);
		const builtIns = await getBuiltInProviderIds();
		if (!PROVIDER_ID_PATTERN.test(id))
			throw new Error(`Invalid provider id "${id}" — use lowercase letters, digits, ".", "_" or "-"`);
		// Mirrors Pi's validateConfig: custom models require a baseUrl and an api.
		if (!CUSTOM_PROVIDER_APIS.includes(request.api)) throw new Error(`Unknown api "${request.api}"`);
		if (request.apiKey !== null && !apiKey) throw new Error("API key must not be empty");
		if (builtIns.has(id)) throw new Error(`"${id}" is a built-in Pi provider — pick another id`);
		const provider: ModelsJsonProvider = { ...(name ? { name } : {}), baseUrl, api: request.api, models: [] };
		if (request.compat !== null) provider.compat = structuredClone(request.compat);
		if (request.api === "openai-completions") {
			// pi's compat heuristic assumes unknown OpenAI-compatible endpoints accept the
			// "developer" role and sends it for reasoning models — most relays/self-hosted
			// servers reject it ("Unexpected message role"). Custom endpoints get the safe
			// default via pi's own compat switch; the built-in OpenAI provider is unaffected.
			applyOpenAiCompletionsCompatibility(provider);
		}
		const label = `add provider "${id}"`;
		const transaction = await commitModelsConfigMutation((config) => {
			if (Object.hasOwn(config.providers, id)) throw new Error(`Provider "${id}" already exists in models.json`);
			// `name` is optional in Pi's schema — omitted, the provider displays as its id.
			config.providers[id] = structuredClone(provider);
		});
		const credentialMutation = { value: null as PiStoredCredentialMutation | null };
		let observeCredentialMutations = true;
		const observeCredentialMutation: PiStoredCredentialMutationObserver = (providerId, mutation) => {
			if (!observeCredentialMutations || providerId !== id) return;
			if (credentialMutation.value && !isDeepStrictEqual(credentialMutation.value.attempted, mutation.previous)) {
				throw new Error(`Credential for provider "${id}" changed between Ling writes`);
			}
			credentialMutation.value = {
				previous: credentialMutation.value?.previous ?? structuredClone(mutation.previous),
				attempted: structuredClone(mutation.attempted),
			};
		};
		try {
			const runtime = await reloadGlobalModelRuntimeForMutation(label, transaction, observeCredentialMutation);
			if (attemptedCredential) {
				// auth.json, not models.json's apiKey field: Pi resolves auth.json first, and this
				// keeps the key manageable through the same UI as every other provider.
				await assertModelsConfigMutationCurrent(label, transaction);
				await storeDirectApiKey(runtime, id, attemptedCredential.key, async () => {
					await reloadGlobalModelRuntimeForMutation(label, transaction, observeCredentialMutation);
				});
				await assertModelsConfigMutationCurrent(label, transaction);
			}
		} catch (error) {
			const failures: unknown[] = [error];
			try {
				await restoreModelsConfigMutation(label, transaction);
			} catch (rollbackError) {
				failures.push(rollbackError);
			}
			if (credentialMutation.value) {
				const previousCredential = credentialMutation.value.previous;
				try {
					const restoredCredential = await restoreCredentialForModelsRollback(
						id,
						transaction,
						credentialMutation.value.attempted,
						previousCredential,
					);
					if (previousCredential.exists && !restoredCredential.exists) {
						failures.push(
							new Error(
								`Credential for provider "${id}" was removed instead of restoring its previous value because models.json changed ownership`,
							),
						);
					}
				} catch (rollbackError) {
					failures.push(rollbackError);
				}
			}
			await reloadCurrentModelRuntimeAfterFailure(failures);
			throwMutationFailures(failures, `Failed to add provider "${id}" and fully restore its previous configuration`);
		} finally {
			observeCredentialMutations = false;
		}
		log.info(`added custom provider ${id} (${request.api})`);
	}

	async function addCustomModelMutation(request: AddCustomModelRequest): Promise<void> {
		const modelId = request.id.trim();
		if (!modelId) throw new Error("Model id must not be empty");
		assertSafeRegistryKey(modelId, "Model id");
		const name = normalizeNullableName(request.name);
		assertNullablePositiveSafeInteger(request.contextWindow, "context window");
		assertNullablePositiveSafeInteger(request.maxTokens, "max tokens");
		if (typeof request.reasoning !== "boolean") throw new Error("Invalid reasoning flag");
		const builtIns = await getBuiltInProviderIds();
		const runtime = await getGlobalModelRuntime();
		if (runtime.getModel(request.provider, modelId))
			throw new Error(`Model "${modelId}" already exists for provider "${request.provider}"`);
		const options = request.options === undefined ? {} : modelOptionsSchema.parse(request.options);
		await mutateModelsConfigAndReload(`add model "${request.provider}/${modelId}"`, (config) => {
			const entry = requireModelProviderEntry(config, request.provider, builtIns);
			const models = entry.models ?? [];
			if (models.some((model) => model.id === modelId)) {
				throw new Error(`Model "${modelId}" already exists for provider "${request.provider}"`);
			}
			// Omitted fields stay omitted — Pi supplies its own defaults (name=id, 128k ctx, 16k out).
			const model: ModelsJsonModel = { id: modelId, ...structuredClone(options) };
			if (name) model.name = name;
			if (request.contextWindow !== null) model.contextWindow = request.contextWindow;
			if (request.maxTokens !== null) model.maxTokens = request.maxTokens;
			if (request.reasoning) model.reasoning = true;
			if (request.samplingParams !== null) model.samplingParams = structuredClone(request.samplingParams);
			if (request.compat !== null) model.compat = structuredClone(request.compat);
			entry.models = [...models, model];
		});
		log.info(`added custom model ${request.provider}/${modelId}`);
	}

	async function removeCustomModelMutation(provider: string, modelId: string): Promise<void> {
		assertSafeRegistryKey(modelId, "Model id");
		const builtIns = await getBuiltInProviderIds();
		await mutateModelsConfigAndReload(`remove model "${provider}/${modelId}"`, (config) => {
			const entry = requireModelProviderEntry(config, provider, builtIns);
			const models = entry.models ?? [];
			if (!models.some((model) => model.id === modelId)) {
				throw new Error(`Model "${modelId}" not found for provider "${provider}"`);
			}
			entry.models = models.filter((model) => model.id !== modelId);
			// Pi rejects an override containing only an empty model list. Removing the
			// last Ling-added definition restores the untouched built-in provider.
			if (builtIns.has(provider) && entry.models.length === 0 && Object.keys(entry).every((key) => key === "models")) {
				delete config.providers[provider];
			}
		});
		log.info(`removed custom model ${provider}/${modelId}`);
	}

	async function removeCustomProviderMutation(provider: string): Promise<void> {
		const builtIns = await getBuiltInProviderIds();
		let configMutation: ModelsConfigMutation<ModelsJsonProvider> | null = null;
		let removedCredential: StoredCredentialSnapshot | null = null;
		const label = `remove provider "${provider}"`;
		try {
			configMutation = await commitModelsConfigMutation((config) => {
				const entry = requireCustomProviderEntry(config, provider, builtIns);
				const snapshot = structuredClone(entry);
				delete config.providers[provider];
				return snapshot;
			});
			// Delete through the credential ownership registry, and capture the exact raw
			// auth.json entry under the same lock so a compensating write cannot resurrect
			// an older value over a concurrent Pi CLI update.
			removedCredential = await deleteStoredProfileCredentialSnapshot(provider, () => {
				if (configMutation) assertModelsConfigMutationCurrentSync(label, configMutation);
			});
			await assertModelsConfigMutationCurrent(label, configMutation);
			await reloadGlobalModelRuntimeForMutation(label, configMutation);
		} catch (error) {
			const failures: unknown[] = [error];
			if (configMutation) {
				try {
					await restoreModelsConfigMutation(label, configMutation);
				} catch (rollbackError) {
					failures.push(rollbackError);
				}
			}
			// Resolve the compensation while auth.json is locked. A concurrent replacement
			// under the same id receives no previous provider secret; only Ling's attempted
			// deletion remains in that case.
			const rollbackConfig = configMutation;
			const credentialSnapshot = removedCredential;
			if (rollbackConfig && credentialSnapshot) {
				try {
					const restoredCredential = await restoreCredentialForModelsRollback(
						provider,
						rollbackConfig,
						{ exists: false },
						credentialSnapshot,
					);
					if (credentialSnapshot.exists && !restoredCredential.exists) {
						failures.push(
							new Error(`Credential for provider "${provider}" remained removed because models.json changed ownership`),
						);
					}
				} catch (rollbackError) {
					failures.push(rollbackError);
				}
			}
			await reloadCurrentModelRuntimeAfterFailure(failures);
			throwMutationFailures(
				failures,
				`Failed to remove provider "${provider}" and fully restore its previous configuration`,
			);
		}
		log.info(`removed custom provider ${provider}`);
	}

	async function updateCustomProviderMutation(request: UpdateCustomProviderRequest): Promise<void> {
		assertSafeRegistryKey(request.provider, "Provider id");
		const baseUrl = normalizeHttpBaseUrl(request.baseUrl);
		const name = normalizeNullableName(request.name);
		if (request.api !== null && !CUSTOM_PROVIDER_APIS.includes(request.api))
			throw new Error(`Unknown api "${request.api}"`);
		const builtIns = await getBuiltInProviderIds();
		await mutateModelsConfigAndReload(`update provider "${request.provider}"`, (config) => {
			const entry = requireCustomProviderEntry(config, request.provider, builtIns);
			if (name) {
				entry.name = name;
			} else {
				delete entry.name;
			}
			entry.baseUrl = baseUrl;
			if (request.api !== null) entry.api = request.api;
			if (request.compat !== null) {
				entry.compat = structuredClone(request.compat);
			} else {
				delete entry.compat;
			}
			applyOpenAiCompletionsCompatibility(entry);
		});
		log.info(`updated custom provider ${request.provider}`);
	}

	async function updateCustomModelMutation(request: UpdateCustomModelRequest): Promise<void> {
		assertSafeRegistryKey(request.modelId, "Model id");
		const name = normalizeNullableName(request.name);
		assertNullablePositiveSafeInteger(request.contextWindow, "context window");
		assertNullablePositiveSafeInteger(request.maxTokens, "max tokens");
		if (typeof request.reasoning !== "boolean") throw new Error("Invalid reasoning flag");
		const builtIns = await getBuiltInProviderIds();
		const options = request.options === undefined ? undefined : modelOptionsSchema.parse(request.options);
		await mutateModelsConfigAndReload(`update model "${request.provider}/${request.modelId}"`, (config) => {
			const entry = requireModelProviderEntry(config, request.provider, builtIns);
			const models = entry.models ?? [];
			const model = models.find((candidate) => candidate.id === request.modelId);
			if (!model) throw new Error(`Model "${request.modelId}" not found for provider "${request.provider}"`);
			if (options !== undefined) {
				for (const key of ["api", "input", "thinkingLevelMap", "cost"] as const) delete model[key];
				Object.assign(model, structuredClone(options));
			}
			// Full-state edit: cleared fields are REMOVED so Pi's own defaults apply again.
			if (name) {
				model.name = name;
			} else {
				delete model.name;
			}
			if (request.contextWindow !== null) {
				model.contextWindow = request.contextWindow;
			} else {
				delete model.contextWindow;
			}
			if (request.maxTokens !== null) {
				model.maxTokens = request.maxTokens;
			} else {
				delete model.maxTokens;
			}
			if (request.reasoning) {
				model.reasoning = true;
			} else {
				delete model.reasoning;
			}
			if (request.samplingParams !== null) {
				model.samplingParams = structuredClone(request.samplingParams);
			} else {
				delete model.samplingParams;
			}
			if (request.compat !== null) {
				model.compat = structuredClone(request.compat);
			} else {
				delete model.compat;
			}
		});
		log.info(`updated custom model ${request.provider}/${request.modelId}`);
	}
	return {
		adoptCatalogModelsMutation,
		addCustomProviderMutation,
		addCustomModelMutation,
		removeCustomModelMutation,
		removeCustomProviderMutation,
		updateCustomProviderMutation,
		updateCustomModelMutation,
	};
}

export type PiModelProviderMutations = ReturnType<typeof createPiModelProviderMutations>;
