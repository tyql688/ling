import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { type BoundedJsonObject, boundedJsonObjectValidationError } from "@ling/contracts/bounded-json";
import { errorMessage } from "@ling/contracts/ling-error";
import {
	type ProjectModelCatalog,
	type ProviderCatalog,
	type ProviderModelDefinition,
	type ProviderModelInfo,
	type ProviderSummary,
	combineProviderCatalogErrors as combinedCatalogError,
	MODEL_SAMPLING_PARAMS_LIMITS,
	modelCompatValidationError,
} from "@ling/contracts/model";
import { portableModelOptions } from "./model-configuration";
import type { PiProjectModelCatalogAccess } from "./model-project-access";
import type { PiModelProjection } from "./model-projection";
import type { PiModelRuntimes } from "./model-runtime";
import { type PiModelsConfig, ModelsConfigGenerationChangedError } from "./models-config";
import { type ModelsJsonConfig, assertSafeRegistryKey, ownProviderEntry } from "./models-config-format";

/** Three complete attempts absorb a normal atomic external edit while bounding
 * a settings request when another Pi process is continuously rewriting models.json. */
const MODEL_CATALOG_GENERATION_ATTEMPTS = 3;

interface ProviderSummaryProjection {
	/** Null when file metadata is unavailable or does not own this runtime generation. */
	customConfig: ModelsJsonConfig | null;
	builtIns: ReadonlySet<string>;
	projectCwd: string | null;
	extensionProviderIds: ReadonlySet<string>;
}

interface ProviderSummaryProjectionResult {
	providers: ProviderSummary[];
	credentialError: string | null;
}

function projectSamplingParams(value: unknown): BoundedJsonObject | null {
	if (value === undefined || boundedJsonObjectValidationError(value, MODEL_SAMPLING_PARAMS_LIMITS)) return null;
	return structuredClone(value) as BoundedJsonObject;
}

function projectCompat(value: unknown): BoundedJsonObject | null {
	if (value === undefined || modelCompatValidationError(value)) return null;
	return structuredClone(value) as BoundedJsonObject;
}

type ModelsJsonModel = NonNullable<ModelsJsonConfig["providers"][string]["models"]>[number];

function projectModelDefinition(value: ModelsJsonModel | undefined): ProviderModelDefinition | null {
	if (value === undefined) return null;
	return {
		name: typeof value.name === "string" ? value.name : null,
		contextWindow: typeof value.contextWindow === "number" ? value.contextWindow : null,
		maxTokens: typeof value.maxTokens === "number" ? value.maxTokens : null,
		reasoning: value.reasoning === true,
		samplingParams: projectSamplingParams(value.samplingParams),
		compat: projectCompat(value.compat),
		options: portableModelOptions(value),
	};
}

export function createPiModelCatalog({
	projects,
	modelRuntimes,
	projection,
	config,
}: {
	projects: PiProjectModelCatalogAccess;
	modelRuntimes: PiModelRuntimes;
	projection: PiModelProjection;
	config: PiModelsConfig;
}) {
	const { hasProjectProviderCredentialConflict, readStoredProjectCredential, withOpenProject } = projects;
	const { getGlobalModelRuntime, hasProfileProviderCredentialConflict, readStoredProfileCredential } = modelRuntimes;
	const { projectAvailableModels } = projection;
	const { getBuiltInProviderIds, readModelsConfigSafe, reloadGlobalModelRuntimeForCatalog } = config;

	async function projectProviderSummaries(
		runtime: ModelRuntime,
		projection: ProviderSummaryProjection,
	): Promise<ProviderSummaryProjectionResult> {
		let credentials: Awaited<ReturnType<ModelRuntime["listCredentials"]>> = [];
		let credentialError: string | null = null;
		try {
			credentials = await runtime.listCredentials();
		} catch (error) {
			// A corrupt or temporarily unreadable auth.json makes credential metadata
			// unknown, not every provider and model nonexistent. Keep the complete model
			// projection and surface the failed read beside Pi's runtime diagnostics.
			credentialError = errorMessage(error);
		}
		const credentialTypes = new Map<string, "api_key" | "oauth">(
			credentials.map((credential) => [credential.providerId, credential.type]),
		);
		const customNames = customProviderNames(projection.customConfig);

		const modelsByProvider = indexProviderModels(runtime.getModels(), projection);

		// A freshly created custom provider has no models yet — it must still show up so the
		// user can add models to it. Union runtime providers/models with models.json entries.
		const providersById = new Map(runtime.getProviders().map((provider) => [provider.id, provider]));
		const allProviderIds = new Set([
			...providersById.keys(),
			...modelsByProvider.keys(),
			...(projection.customConfig === null ? [] : Object.keys(projection.customConfig.providers)),
			...projection.extensionProviderIds,
		]);

		const summaries: ProviderSummary[] = [];
		for (const providerId of allProviderIds) {
			const provider = providersById.get(providerId);
			const status = runtime.getProviderAuthStatus(providerId);
			const credentialStatus = credentialError === null ? "known" : "unknown";
			const projectExtension = projection.extensionProviderIds.has(providerId);
			const authConflict =
				projection.projectCwd === null
					? hasProfileProviderCredentialConflict(providerId)
					: hasProjectProviderCredentialConflict(projection.projectCwd, providerId);
			const credentialType = authConflict ? null : (credentialTypes.get(providerId) ?? null);
			const customEntry =
				projectExtension || projection.builtIns.has(providerId) || projection.customConfig === null
					? undefined
					: ownProviderEntry(projection.customConfig.providers, providerId);
			summaries.push({
				id: providerId,
				name: typeof customEntry?.name === "string" ? customEntry.name : null,
				displayName: provider?.name ?? customNames.get(providerId) ?? providerId,
				credentialStatus,
				configured: !authConflict && status.configured,
				source: authConflict || status.source === undefined ? null : status.source,
				sourceLabel: authConflict || status.label === undefined ? null : status.label,
				credentialType,
				authMethods: providerAuthMethods(provider),
				projectExtension,
				projectCwd: projectExtension ? projection.projectCwd : null,
				authConflict,
				custom: customEntry !== undefined,
				baseUrl: typeof customEntry?.baseUrl === "string" ? customEntry.baseUrl : null,
				api: typeof customEntry?.api === "string" ? customEntry.api : null,
				// Provider compat is an explicit models.json default. Runtime models have
				// already merged it with inferred and model-level compatibility fields.
				compat: projectCompat(customEntry?.compat),
				models: modelsByProvider.get(providerId) ?? [],
			});
		}
		summaries.sort((a, b) => a.displayName.localeCompare(b.displayName, "en"));
		return { providers: summaries, credentialError };
	}

	async function listProvidersNow(): Promise<ProviderCatalog> {
		for (let attempt = 1; attempt <= MODEL_CATALOG_GENERATION_ATTEMPTS; attempt += 1) {
			const customRead = await readModelsConfigSafe();
			try {
				// Build an offline profile generation only after Ling's bounded validation.
				// Keep the previous generation on malformed input so the settings page can
				// report the config error without replacing its last usable catalog. Pi's
				// refresh() also reloads models.json, so refreshing the retained runtime here
				// would discard that last usable generation.
				const current =
					customRead.error === null && customRead.generation !== null
						? await reloadGlobalModelRuntimeForCatalog(customRead.generation)
						: { runtime: await getGlobalModelRuntime(), configError: null };
				const runtime = current.runtime;
				const builtIns = await getBuiltInProviderIds();
				const projection = await projectProviderSummaries(runtime, {
					// A retained runtime must not acquire editable fields from the rejected
					// candidate. Hide unavailable file metadata while reporting the error;
					// the next valid generation restores the editing controls.
					customConfig: customRead.error === null && current.configError === null ? customRead.config : null,
					builtIns,
					projectCwd: null,
					extensionProviderIds: new Set(),
				});
				const runtimeError = runtime.getError();
				return {
					providers: projection.providers,
					configError: combinedCatalogError(
						customRead.error,
						current.configError,
						runtimeError,
						projection.credentialError,
					),
				};
			} catch (error) {
				if (!(error instanceof ModelsConfigGenerationChangedError) || attempt === MODEL_CATALOG_GENERATION_ATTEMPTS) {
					throw error;
				}
			}
		}
		throw new Error("Model catalog generation retry loop exited unexpectedly");
	}

	/** Effective available models for a specific open project, including providers
	 * registered by that project's extensions and packages. */
	async function listProjectModels(cwd: string): Promise<ProjectModelCatalog> {
		return withOpenProject(cwd, async (services) => {
			const customRead = await readModelsConfigSafe();
			const extensionProviderIds = new Set(services.modelRuntime.getRegisteredProviderIds());
			const projection = await projectProviderSummaries(services.modelRuntime, {
				// These providers belong to this project's loaded extension generation,
				// not to the current profile file, which may have changed independently.
				customConfig: null,
				builtIns: await getBuiltInProviderIds(),
				projectCwd: services.cwd,
				extensionProviderIds,
			});
			const runtimeError = services.modelRuntime.getError();
			return {
				cwd: services.cwd,
				models: projectAvailableModels(services.modelRuntime),
				extensionProviders: projection.providers.filter((provider) => provider.projectExtension),
				configError: combinedCatalogError(customRead.error, runtimeError, projection.credentialError),
			};
		});
	}

	/** Explicit, on-demand credential read for the model settings reveal control. */
	async function getProviderApiKey(provider: string): Promise<string | null> {
		assertSafeRegistryKey(provider, "Provider id");
		const credential = await readStoredProfileCredential(provider);
		return credential?.type === "api_key" && typeof credential.key === "string" ? credential.key : null;
	}

	async function getProjectProviderApiKey(cwd: string, provider: string): Promise<string | null> {
		assertSafeRegistryKey(provider, "Provider id");
		return withOpenProject(cwd, async () => {
			const credential = await readStoredProjectCredential(cwd, provider);
			return credential?.type === "api_key" && typeof credential.key === "string" ? credential.key : null;
		});
	}
	return { listProvidersNow, listProjectModels, getProviderApiKey, getProjectProviderApiKey };
}

export type PiModelCatalog = ReturnType<typeof createPiModelCatalog>;

function customProviderNames(config: ModelsJsonConfig | null) {
	const customNames = new Map<string, string>();
	if (config !== null) {
		for (const [id, entry] of Object.entries(config.providers)) {
			if (typeof entry.name === "string" && entry.name.length > 0) customNames.set(id, entry.name);
		}
	}
	return customNames;
}

function indexProviderModels(models: ReturnType<ModelRuntime["getModels"]>, projection: ProviderSummaryProjection) {
	const modelsByProvider = new Map<string, ProviderModelInfo[]>();
	for (const model of models) {
		const configuredModel =
			projection.customConfig === null || projection.extensionProviderIds.has(model.provider)
				? undefined
				: ownProviderEntry(projection.customConfig.providers, model.provider)?.models?.find(
						(candidate) => candidate.id === model.id,
					);
		const info: ProviderModelInfo = {
			id: model.id,
			name: model.name,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			reasoning: model.reasoning,
			// Keep effective runtime values out of the editable definition. Saving inferred
			// defaults would freeze Pi's evolving provider behavior in models.json.
			definition: projectModelDefinition(configuredModel),
		};
		const existing = modelsByProvider.get(model.provider);
		if (existing) {
			existing.push(info);
		} else {
			modelsByProvider.set(model.provider, [info]);
		}
	}
	return modelsByProvider;
}

function providerAuthMethods(
	provider: ReturnType<ModelRuntime["getProviders"]>[number] | undefined,
): ProviderSummary["authMethods"] {
	return {
		apiKey: provider?.auth.apiKey
			? { name: provider.auth.apiKey.name, interactive: provider.auth.apiKey.login !== undefined }
			: null,
		oauth: provider?.auth.oauth
			? {
					name: provider.auth.oauth.name,
					loginLabel: provider.auth.oauth.loginLabel ?? null,
				}
			: null,
	};
}
