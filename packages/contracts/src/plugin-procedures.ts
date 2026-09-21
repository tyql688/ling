import { argumentsOf, event, request, returns } from "./procedure";
import type {
	CancelPluginOperationRequest,
	CancelPluginOperationResponse,
	ConfiguredPackage,
	InstallPluginRequest,
	PluginMutationResponse,
	PluginProgressEvent,
	PluginProjectRequest,
	PluginUpdateInfo,
	RemovePluginRequest,
	UpdatePluginRequest,
} from "./plugin";
import { createPluginRequestSchemas } from "./plugin-requests";
import { portableProcedurePaths, type ProcedurePaths } from "./procedure-paths";
export function createPluginsProcedures(paths: ProcedurePaths = portableProcedurePaths) {
	const schemas = createPluginRequestSchemas(paths.absolute("Plugin project path"));
	return {
		list: request(
			"plugins:list",
			argumentsOf<[request: PluginProjectRequest]>((args) => [schemas.pluginProjectRequestSchema.parse(args[0])]),
			returns<ConfiguredPackage[]>(),
		),
		checkUpdates: request(
			"plugins:checkUpdates",
			argumentsOf<[request: PluginProjectRequest]>((args) => [schemas.pluginProjectRequestSchema.parse(args[0])]),
			returns<PluginUpdateInfo[]>(),
		),
		install: request(
			"plugins:install",
			argumentsOf<[request: InstallPluginRequest]>((args) => [schemas.installPluginRequestSchema.parse(args[0])]),
			returns<PluginMutationResponse>(),
		),
		remove: request(
			"plugins:remove",
			argumentsOf<[request: RemovePluginRequest]>((args) => [schemas.removePluginRequestSchema.parse(args[0])]),
			returns<PluginMutationResponse>(),
		),
		update: request(
			"plugins:update",
			argumentsOf<[request: UpdatePluginRequest]>((args) => [schemas.updatePluginRequestSchema.parse(args[0])]),
			returns<PluginMutationResponse>(),
		),
		cancelOperation: request(
			"plugins:cancelOperation",
			argumentsOf<[request: CancelPluginOperationRequest]>((args) => [
				schemas.cancelPluginOperationRequestSchema.parse(args[0]),
			]),
			returns<CancelPluginOperationResponse>(),
		),
		onProgress: event("plugins:progress", returns<PluginProgressEvent>()),
	};
}
export const pluginsProcedures = createPluginsProcedures();
