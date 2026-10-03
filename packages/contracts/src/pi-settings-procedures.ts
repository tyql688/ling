import { argumentsOf, event, noArguments, request, returns } from "./procedure";
import type { PiSettingsRecoveryStatus, PiSettingsSnapshot, PiSettingsUpdate } from "./pi-settings";
import { createPiSettingsUpdateSchema } from "./pi-settings-requests";
import { portableProcedurePaths, type ProcedurePaths } from "./procedure-paths";
import {
	piConfigurationReadSchema,
	piConfigurationWriteSchema,
	type PiConfigurationSnapshot,
	type PiConfigurationWriteResult,
} from "./pi-configuration";
export function createPiSettingsProcedures(paths: ProcedurePaths = portableProcedurePaths) {
	const schemas = {
		piSettingsUpdateSchema: createPiSettingsUpdateSchema(
			(value) => paths.isAbsolute(value) || paths.isTildePath(value),
		),
	};
	return {
		configuration: request(
			"pi-settings:configuration",
			argumentsOf((args) => [piConfigurationReadSchema.parse(args[0])]),
			returns<PiConfigurationSnapshot>(),
		),
		writeConfiguration: request(
			"pi-settings:write-configuration",
			argumentsOf((args) => [piConfigurationWriteSchema.parse(args[0])]),
			returns<PiConfigurationWriteResult>(),
		),
		onChanged: event("pi-settings:changed", returns<null>()),
		get: request("pi-settings:get", noArguments, returns<PiSettingsSnapshot>()),
		getRecoveryStatus: request("pi-settings:get-recovery-status", noArguments, returns<PiSettingsRecoveryStatus>()),
		repairHttpIdleTimeout: request("pi-settings:repair-http-idle-timeout", noArguments, returns<PiSettingsSnapshot>()),
		update: request(
			"pi-settings:update",
			argumentsOf<[update: PiSettingsUpdate]>((args) => [schemas.piSettingsUpdateSchema.parse(args[0])]),
			returns<PiSettingsSnapshot>(),
		),
	};
}
export const piSettingsProcedures = createPiSettingsProcedures();
