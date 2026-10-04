import { type ModelInfo, THINKING_LEVELS, type ThinkingLevel } from "@ling/contracts/session";

interface QuickStartDefaultModel {
	provider: string;
	id: string;
	name: string;
	reasoning: boolean;
	availableThinkingLevels: ThinkingLevel[];
}

interface QuickStartModelSelection {
	provider: string;
	id: string;
}

interface PiModelDefaults {
	defaultProvider: string | null;
	defaultModel: string | null;
	defaultThinkingLevel: ThinkingLevel | null;
}

/** Resolves the saved provider/model against the project's authenticated model catalog. Returns null when it is unavailable, so Pi can select a model and the UI can show a generic label until that selection arrives. */
export function resolveQuickStartDefaultModel(
	models: readonly ModelInfo[],
	defaults: PiModelDefaults | null,
): QuickStartDefaultModel | null {
	if (!defaults?.defaultProvider || !defaults.defaultModel) return null;
	const model = models.find(
		(candidate) => candidate.provider === defaults.defaultProvider && candidate.id === defaults.defaultModel,
	);
	if (!model) return null;
	return {
		provider: model.provider,
		id: model.id,
		name: model.name,
		reasoning: model.reasoning,
		availableThinkingLevels: model.availableThinkingLevels,
	};
}

/** Resolves the draft's requested model against the selected project's authenticated catalog and returns that catalog's metadata. */
export function resolveQuickStartSelectedModel(
	selection: QuickStartModelSelection | null,
	models: readonly ModelInfo[],
): ModelInfo | null {
	if (!selection) return null;
	return models.find((model) => model.provider === selection.provider && model.id === selection.id) ?? null;
}

/** Pi applies the configured thinking default independently of model resolution,
 * then clamps it to whichever model the SDK ultimately selects. */
export function resolveQuickStartThinkingLevel(
	defaults: Pick<PiModelDefaults, "defaultThinkingLevel"> | null,
	availableLevels?: readonly ThinkingLevel[],
): ThinkingLevel {
	const requested = defaults?.defaultThinkingLevel ?? "medium";
	if (!availableLevels || availableLevels.length === 0 || availableLevels.includes(requested)) return requested;
	const requestedIndex = THINKING_LEVELS.indexOf(requested);
	for (let index = requestedIndex; index < THINKING_LEVELS.length; index += 1) {
		const candidate = THINKING_LEVELS[index];
		if (candidate && availableLevels.includes(candidate)) return candidate;
	}
	for (let index = requestedIndex - 1; index >= 0; index -= 1) {
		const candidate = THINKING_LEVELS[index];
		if (candidate && availableLevels.includes(candidate)) return candidate;
	}
	// Clamp the preview to the supported thinking levels, including the final fallback.

	return availableLevels[0] ?? "off";
}
