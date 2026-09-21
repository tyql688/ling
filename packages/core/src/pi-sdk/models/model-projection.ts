import type { PiModelRuntimes } from "./model-runtime";
import type { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { type ModelInfo, THINKING_LEVELS, type ThinkingLevel } from "@ling/contracts/session";

type RuntimeModel = ReturnType<ModelRuntime["getAvailableSnapshot"]>[number];

function modelKey(provider: string, id: string): string {
	return JSON.stringify([provider, id]);
}

/** Mirrors Pi AI's getSupportedThinkingLevels without importing its transitive package. */
function projectAvailableThinkingLevels(model: RuntimeModel): ThinkingLevel[] {
	if (!model.reasoning) return ["off"];
	return THINKING_LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		if (level === "xhigh" || level === "max") return mapped !== undefined;
		return true;
	});
}

export function createPiModelProjection(modelRuntimes: Pick<PiModelRuntimes, "hasAmbiguousPiProviderCredential">) {
	const { hasAmbiguousPiProviderCredential } = modelRuntimes;

	/** Projects the SDK's authenticated/available snapshot without flattening away
	 * extension provider names or slash-bearing model ids. */
	function projectAvailableModels(runtime: ModelRuntime): ModelInfo[] {
		return runtime.getAvailableSnapshot().flatMap((model) => {
			const auth = runtime.getProviderAuthStatus(model.provider);
			// ModelRuntime snapshots are intentionally synchronous and can predate a
			// second project opening. Stored credentials for a colliding extension
			// provider are no longer safe even if that cached snapshot says otherwise.
			if (auth.source === "stored" && hasAmbiguousPiProviderCredential(runtime, model.provider)) return [];
			return [
				{
					provider: model.provider,
					providerName: runtime.getProvider(model.provider)?.name ?? model.provider,
					id: model.id,
					name: model.name,
					reasoning: model.reasoning,
					availableThinkingLevels: projectAvailableThinkingLevels(model),
					contextWindow: model.contextWindow,
				},
			];
		});
	}

	function projectSessionModels(session: AgentSession): ModelInfo[] {
		const available = projectAvailableModels(session.modelRuntime);
		if (session.scopedModels.length === 0) return available;
		const availableByKey = new Map(available.map((model) => [modelKey(model.provider, model.id), model]));
		return session.scopedModels.flatMap((entry) => {
			const model = availableByKey.get(modelKey(entry.model.provider, entry.model.id));
			return model ? [model] : [];
		});
	}
	return { projectAvailableModels, projectSessionModels };
}

export type PiModelProjection = ReturnType<typeof createPiModelProjection>;
