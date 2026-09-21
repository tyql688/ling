import { argumentsOf, event, noArguments, request, returns } from "./procedure";
import type { PiSettingsRecoveryStatus, PiSettingsSnapshot, PiSettingsUpdate } from "./pi-settings";
import { createPiSettingsUpdateSchema } from "./pi-settings-requests";
import { portableProcedurePaths, type ProcedurePaths } from "./procedure-paths";
export function createPiSettingsProcedures(paths: ProcedurePaths = portableProcedurePaths) {
	const schemas = {
		piSettingsUpdateSchema: createPiSettingsUpdateSchema(
			(value) => paths.isAbsolute(value) || paths.isTildePath(value),
		),
	};
	return {
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
