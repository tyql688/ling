import { builtinFeaturesProcedures } from "@ling/contracts/builtin-feature-procedures";
import type { HostDomain } from "../../transport/host-domain";
import type { ResourceReloadCoordinator } from "../resources/resource-reload";
import { piResourceReloadError } from "../resources/resource-reload";
import type { BuiltinFeatureStore } from "./builtin-features";

export function createBuiltinFeatureDomain(options: {
	features: BuiltinFeatureStore;
	resources: ResourceReloadCoordinator;
	onChanged(): void;
}): HostDomain {
	return {
		handlers: {
			[builtinFeaturesProcedures.read.channel]: async () => options.features.read(),
			[builtinFeaturesProcedures.write.channel]: async (context, input) => {
				const result = await options.resources.mutateThenReloadPiResources(
					"Feature change and resource reload failed",
					async () => {
						await options.features.write(input, context.signal);
						options.onChanged();
					},
				);
				if (result.mutation.failed) {
					const failure = piResourceReloadError(result.reload);
					if (failure) throw new AggregateError([result.mutation.error, failure], "Feature change failed");
					throw result.mutation.error;
				}
				return result.reload;
			},
		},
	};
}
