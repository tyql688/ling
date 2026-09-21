import { builtinFeatureUpdateSchema, type BuiltinFeatures, type BuiltinFeatureUpdate } from "./builtin-features";
import { argumentsOf, event, noArguments, request, returns } from "./procedure";
import type { PiResourceReloadSummary } from "./session";

export const builtinFeaturesProcedures = {
	read: request("builtinFeatures:read", noArguments, returns<BuiltinFeatures>()),
	write: request(
		"builtinFeatures:write",
		argumentsOf((args): [BuiltinFeatureUpdate] => [builtinFeatureUpdateSchema.parse(args[0])]),
		returns<PiResourceReloadSummary>(),
	),
	onChanged: event("builtinFeatures:changed", returns<null>()),
};
