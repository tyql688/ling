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

/**
 * Mirrors the SDK's findInitialModel step that honors the saved default: it applies only
 * when the configured provider/model exists in the project's authenticated/available
 * model snapshot. When it does not resolve, the SDK picks its own model — we make no
 * guess about that pick and return null so the UI shows the generic label.
 */
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

/** A draft keeps its requested model across folder changes, but only the new project's
 * authenticated catalog can resolve it. Always return current metadata, never the old pick. */
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
	// Line-for-line mirror of pi-ai's clampThinkingLevel, including this tail, so the
	// quick-start preview can never diverge from what the SDK ultimately selects.
	return availableLevels[0] ?? "off";
}
