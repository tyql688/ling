import { accessActivationUpdateSchema, type AccessActivation, type AccessActivationUpdate } from "./permissions";
import { portableAbsolutePathSchema } from "./path-validation";
import { argumentsOf, event, noArguments, request, returns } from "./procedure";

export const permissionsProcedures = {
	read: request("permissions:read", noArguments, returns<AccessActivation>()),
	write: request(
		"permissions:write",
		argumentsOf((args): [AccessActivationUpdate] => [accessActivationUpdateSchema.parse(args[0])]),
		returns<{ deferred: number }>(),
	),
	prepareRulesFile: request(
		"permissions:prepareRulesFile",
		argumentsOf((args): [string | null] => [portableAbsolutePathSchema("Project path").nullable().parse(args[0])]),
		returns<string>(),
	),
	onChanged: event("permissions:changed", returns<AccessActivation>()),
};
