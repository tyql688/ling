import { argumentsOf, noArguments, request, returns } from "./procedure";
import type { AppSettingsReadResult, AppSettingsSnapshot, AppSettingsUpdate } from "./application";
import * as schemas from "./application-requests";
export const appProcedures = {
	getSettings: request("app:getSettings", noArguments, returns<AppSettingsReadResult>()),
	updateSettings: request(
		"app:updateSettings",
		argumentsOf<[update: AppSettingsUpdate]>((args) => [schemas.appSettingsUpdateSchema.parse(args[0])]),
		returns<AppSettingsSnapshot>(),
	),
	resetSettings: request(
		"app:resetSettings",
		argumentsOf<[]>((args) => {
			schemas.emptyAppSettingsRequestSchema.parse(args[0]);
			return [];
		}),
		returns<AppSettingsSnapshot>(),
	),
};
