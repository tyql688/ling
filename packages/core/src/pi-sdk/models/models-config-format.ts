import { type BoundedJsonObject, boundedJsonObjectValidationError } from "@ling/contracts/bounded-json";
import { MODEL_SAMPLING_PARAMS_LIMITS, modelCompatValidationError } from "@ling/contracts/model";
import { RESERVED_OBJECT_KEYS } from "@ling/contracts/text-validation";
import { stripJsonComments } from "@ling/core/pi-sdk/jsonc";

export interface ModelsJsonModel {
	id: string;
	name?: string;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	samplingParams?: BoundedJsonObject;
	compat?: BoundedJsonObject;
	[key: string]: unknown;
}

interface ModelsJsonModelOverride {
	samplingParams?: BoundedJsonObject;
	compat?: BoundedJsonObject;
	[key: string]: unknown;
}

export interface ModelsJsonProvider {
	name?: string;
	baseUrl?: string;
	api?: string;
	compat?: BoundedJsonObject;
	models?: ModelsJsonModel[];
	modelOverrides?: Record<string, ModelsJsonModelOverride>;
	[key: string]: unknown;
}

export interface ModelsJsonConfig {
	providers: Record<string, ModelsJsonProvider>;
	[key: string]: unknown;
}

export function assertSafeRegistryKey(value: string, label: string): void {
	if (RESERVED_OBJECT_KEYS.has(value)) throw new Error(`${label} "${value}" is reserved`);
}

export function ownProviderEntry(
	providers: Record<string, ModelsJsonProvider>,
	provider: string,
): ModelsJsonProvider | undefined {
	return Object.hasOwn(providers, provider) ? providers[provider] : undefined;
}

export function createEmptyModelsConfig(): ModelsJsonConfig {
	return { providers: {} };
}

function assertSamplingParams(
	value: unknown,
	provider: string,
	modelId: string,
	source: "model" | "model override",
): void {
	if (value === undefined) return;
	const issue = boundedJsonObjectValidationError(value, MODEL_SAMPLING_PARAMS_LIMITS);
	if (issue) {
		throw new Error(`models.json provider "${provider}" ${source} "${modelId}" has invalid samplingParams: ${issue}`);
	}
}

function assertCompat(value: unknown, location: string): void {
	if (value === undefined) return;
	const issue = modelCompatValidationError(value);
	if (issue) {
		throw new Error(`models.json ${location} has invalid compat: ${issue}`);
	}
}

/** Throws with a readable message on malformed JSON — CRUD must not clobber a broken file. */
export function parseModelsConfig(source: string, path: string): ModelsJsonConfig {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripJsonComments(source));
	} catch (error) {
		throw new Error(`Invalid models.json: ${path}`, { cause: error });
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`models.json is not an object: ${path}`);
	}
	const config = parsed as ModelsJsonConfig;
	if (config.providers === undefined) config.providers = {};
	if (typeof config.providers !== "object" || config.providers === null || Array.isArray(config.providers)) {
		throw new Error(`models.json providers is not an object: ${path}`);
	}
	for (const [provider, entry] of Object.entries(config.providers)) {
		assertSafeRegistryKey(provider, "Provider id");
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
			throw new Error(`models.json provider "${provider}" is not an object: ${path}`);
		}
		assertCompat(entry.compat, `provider "${provider}"`);
		if (entry.models !== undefined) {
			if (!Array.isArray(entry.models))
				throw new Error(`models.json provider "${provider}" models is not an array: ${path}`);
			const modelIds = new Set<string>();
			for (const model of entry.models) {
				if (
					typeof model !== "object" ||
					model === null ||
					Array.isArray(model) ||
					typeof model.id !== "string" ||
					model.id.length === 0
				) {
					throw new Error(`models.json provider "${provider}" contains an invalid model: ${path}`);
				}
				assertSafeRegistryKey(model.id, "Model id");
				if (modelIds.has(model.id)) {
					throw new Error(`models.json provider "${provider}" defines model "${model.id}" more than once: ${path}`);
				}
				modelIds.add(model.id);
				assertSamplingParams(model.samplingParams, provider, model.id, "model");
				assertCompat(model.compat, `provider "${provider}" model "${model.id}"`);
			}
		}
		if (entry.modelOverrides !== undefined) {
			if (
				typeof entry.modelOverrides !== "object" ||
				entry.modelOverrides === null ||
				Array.isArray(entry.modelOverrides)
			) {
				throw new Error(`models.json provider "${provider}" modelOverrides is not an object: ${path}`);
			}
			for (const [modelId, override] of Object.entries(entry.modelOverrides)) {
				assertSafeRegistryKey(modelId, "Model id");
				if (typeof override !== "object" || override === null || Array.isArray(override)) {
					throw new Error(`models.json provider "${provider}" model override "${modelId}" is not an object: ${path}`);
				}
				assertSamplingParams(override.samplingParams, provider, modelId, "model override");
				assertCompat(override.compat, `provider "${provider}" model override "${modelId}"`);
			}
		}
	}
	return config;
}

export function serializeModelsConfig(config: ModelsJsonConfig): string {
	return `${JSON.stringify(config, null, 2)}\n`;
}
