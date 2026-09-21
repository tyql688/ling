import type { PiProjectModelAccess } from "./model-project-access";
import type { PiModelsConfig } from "./models-config";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { boundedJsonObjectValidationError, type BoundedJsonObject } from "@ling/contracts/bounded-json";
import {
	MODEL_SAMPLING_PARAMS_LIMITS,
	modelOptionsSchema,
	type ModelConfiguration,
	type ModelConfigurationRequest,
	type ModelOptions,
} from "@ling/contracts/model";
import { ownProviderEntry, type ModelsJsonConfig } from "./models-config-format";

/** These fields can be moved between model definitions without copying credentials or connection overrides. */
export function portableModelOptions(value: object): ModelOptions {
	const fields: Record<string, unknown> = {};
	const record = value as Record<string, unknown>;
	for (const key of ["api", "input", "thinkingLevelMap", "cost", "promptCache"] as const) {
		if (Object.hasOwn(record, key) && record[key] !== undefined) fields[key] = structuredClone(record[key]);
	}
	return modelOptionsSchema.parse(fields);
}

function configurationObject(value: unknown): BoundedJsonObject {
	const issue = boundedJsonObjectValidationError(value, MODEL_SAMPLING_PARAMS_LIMITS);
	if (issue) throw new Error(`Cannot inspect model configuration: ${issue}`);
	return structuredClone(value) as BoundedJsonObject;
}

/** A URL can carry credentials even though no auth.json data was requested. */
function displayBaseUrl(value: string): string {
	const url = URL.canParse(value) ? new URL(value) : null;
	if (!url) return value;
	if (url.username) url.username = "redacted";
	if (url.password) url.password = "redacted";
	for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, "redacted");
	return url.href;
}

function inspectFields(value: object): BoundedJsonObject {
	const fields: Record<string, unknown> = {};
	const record = value as Record<string, unknown>;
	for (const key of [
		"id",
		"name",
		"api",
		"baseUrl",
		"reasoning",
		"input",
		"cost",
		"promptCache",
		"contextWindow",
		"maxTokens",
		"thinkingLevelMap",
		"samplingParams",
		"compat",
	] as const) {
		if (Object.hasOwn(record, key) && record[key] !== undefined) fields[key] = record[key];
	}
	if (typeof fields.baseUrl === "string") fields.baseUrl = displayBaseUrl(fields.baseUrl);
	return configurationObject(fields);
}

function projectConfiguration(
	runtime: ModelRuntime,
	config: ModelsJsonConfig,
	request: ModelConfigurationRequest,
): ModelConfiguration {
	const model = runtime.getModel(request.provider, request.modelId);
	if (!model)
		throw new Error(`Model "${request.provider}/${request.modelId}" is no longer available. Refresh the model list.`);
	const provider = ownProviderEntry(config.providers, request.provider);
	const extension = runtime.getRegisteredProviderIds().includes(request.provider);
	const definition = extension ? undefined : provider?.models?.find((entry) => entry.id === request.modelId);
	const override = provider?.modelOverrides?.[request.modelId];
	return {
		effective: inspectFields(model),
		configured: definition ? inspectFields(definition) : null,
		overrides: override ? inspectFields(override) : null,
		providerDefaults: provider
			? inspectFields({ api: provider.api, baseUrl: provider.baseUrl, compat: provider.compat })
			: {},
		source: extension ? "extension" : definition ? "custom" : "builtin",
		hasModelHeaders: definition?.headers !== undefined || override?.headers !== undefined,
		template: {
			name: model.name,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			reasoning: model.reasoning,
			samplingParams: model.samplingParams === undefined ? null : configurationObject(model.samplingParams),
			compat: model.compat === undefined ? null : configurationObject(model.compat),
			options: portableModelOptions(model),
		},
	};
}

export function createPiModelConfiguration({
	projects,
	config,
}: {
	projects: PiProjectModelAccess;
	config: PiModelsConfig;
}) {
	const { withOpenProject } = projects;
	const { readModelsConfigSafe, reloadGlobalModelRuntimeForCatalog } = config;

	/** Read configuration only when a detail/editor is opened, without resolving authentication or making model calls. */
	async function getModelConfiguration(request: ModelConfigurationRequest): Promise<ModelConfiguration> {
		const read = await readModelsConfigSafe();
		if (read.error !== null) throw new Error(read.error);
		if (request.cwd !== null) {
			return withOpenProject(request.cwd, async (services) =>
				projectConfiguration(services.modelRuntime, read.config, request),
			);
		}
		if (read.generation === null)
			throw new Error("The model configuration generation is unavailable. Refresh and try again.");
		const current = await reloadGlobalModelRuntimeForCatalog(read.generation);
		if (current.configError !== null) throw new Error(current.configError);
		return projectConfiguration(current.runtime, read.config, request);
	}
	return { getModelConfiguration };
}

export type PiModelConfiguration = ReturnType<typeof createPiModelConfiguration>;
