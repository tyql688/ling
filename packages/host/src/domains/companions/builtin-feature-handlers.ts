import { builtinFeaturesProcedures } from "@ling/contracts/builtin-feature-procedures";
import type { HostDomain } from "../../transport/host-domain";
import type { ResourceReloadCoordinator } from "../resources/resource-reload";
import { changeBuiltinFeature } from "./builtin-feature-change";
import type { BuiltinFeatureStore } from "./builtin-features";
import type { BuiltinFeatureId } from "@ling/contracts/builtin-features";

export function createBuiltinFeatureDomain(options: {
	features: BuiltinFeatureStore;
	resources: ResourceReloadCoordinator;
	onChanged(id: BuiltinFeatureId, enabled: boolean): void;
}): HostDomain {
	return {
		handlers: {
			[builtinFeaturesProcedures.read.channel]: async () => options.features.read(),
			[builtinFeaturesProcedures.write.channel]: (context, input) =>
				changeBuiltinFeature(options, input, context.signal),
		},
	};
}
