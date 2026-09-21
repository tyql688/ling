import { argumentsOf, event, noArguments, request, returns } from "./procedure";
import {
	userStateImportSchema,
	userStateUpdateSchema,
	type UserStateChange,
	type UserStateImport,
	type UserStateMutation,
	type UserStateSnapshot,
} from "./user-state";

export const userStateProcedures = {
	get: request("userState:get", noArguments, returns<UserStateSnapshot>()),
	update: request(
		"userState:update",
		argumentsOf<[mutations: UserStateMutation[]]>((args) => [userStateUpdateSchema.parse(args[0])]),
		returns<UserStateChange>(),
	),
	importLegacy: request(
		"userState:importLegacy",
		argumentsOf<[value: UserStateImport]>((args) => [userStateImportSchema.parse(args[0])]),
		returns<UserStateChange>(),
	),
	onChanged: event("userState:changed", returns<UserStateChange>()),
};
