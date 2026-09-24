import type { BuiltinFeatureId, BuiltinFeatureUpdate } from "@ling/contracts/builtin-features";
import { piResourceReloadError, type ResourceReloadCoordinator } from "../resources/resource-reload";
import type { BuiltinFeatureStore } from "./builtin-features";

/** UI and conversation changes use the same persisted switch and resource reconciliation. */
export async function changeBuiltinFeature(
	options: {
		features: BuiltinFeatureStore;
		resources: Pick<ResourceReloadCoordinator, "mutateThenReloadPiResources">;
		onChanged(id: BuiltinFeatureId, enabled: boolean): void;
	},
	input: BuiltinFeatureUpdate,
	signal: AbortSignal,
) {
	const result = await options.resources.mutateThenReloadPiResources(
		"Feature change and resource reload failed",
		async () => {
			if (!(await options.features.write(input, signal))) return [];
			options.onChanged(input.id, input.enabled);
		},
		{
			mode: "adapters",
			// These tools are registered only in live session graphs.
			reloadProjectCatalogs: !["questions", "background-tasks", "schedules"].includes(input.id),
		},
	);
	if (result.mutation.failed) {
		const failure = piResourceReloadError(result.reload);
		if (failure) throw new AggregateError([result.mutation.error, failure], "Feature change failed");
		throw result.mutation.error;
	}
	return result.reload;
}
