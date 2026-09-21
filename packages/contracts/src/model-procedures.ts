import { argumentsOf, event, noArguments, request, returns } from "./procedure";
import type {
	AddCustomModelRequest,
	AddCustomProviderRequest,
	EndpointProbeResult,
	LoginCancelRequest,
	LoginRespondRequest,
	LoginStartRequest,
	ModelCatalogRefreshResult,
	ModelConfiguration,
	ModelConfigurationRequest,
	ModelLoginEventEnvelope,
	ProbeCustomProviderRequest,
	ProjectModelCatalog,
	ProjectModelCatalogRequest,
	ProviderAuthTarget,
	ProviderCatalog,
	RemoveCustomModelRequest,
	SetProviderApiKeyRequest,
	UpdateCustomModelRequest,
	UpdateCustomProviderRequest,
} from "./model";
import * as schemas from "./model-requests";
export const modelsProcedures = {
	onOpenExternal: event("models:open-external", returns<string>()),
	listProviders: request("models:listProviders", noArguments, returns<ProviderCatalog>()),
	getConfiguration: request(
		"models:getConfiguration",
		argumentsOf<[request: ModelConfigurationRequest]>((args) => [
			schemas.modelConfigurationRequestSchema.parse(args[0]),
		]),
		returns<ModelConfiguration>(),
	),
	listProjectModels: request(
		"models:listProjectModels",
		argumentsOf<[request: ProjectModelCatalogRequest]>((args) => [
			schemas.projectModelCatalogRequestSchema.parse(args[0]),
		]),
		returns<ProjectModelCatalog>(),
	),
	getApiKey: request(
		"models:getApiKey",
		argumentsOf<[target: ProviderAuthTarget]>((args) => [schemas.providerAuthTargetSchema.parse(args[0])]),
		returns<string | null>(),
	),
	setApiKey: request(
		"models:setApiKey",
		argumentsOf<[request: SetProviderApiKeyRequest]>((args) => [schemas.setProviderApiKeyRequestSchema.parse(args[0])]),
		returns<void>(),
	),
	removeAuth: request(
		"models:removeAuth",
		argumentsOf<[target: ProviderAuthTarget]>((args) => [schemas.providerAuthTargetSchema.parse(args[0])]),
		returns<void>(),
	),
	addProvider: request(
		"models:addProvider",
		argumentsOf<[request: AddCustomProviderRequest]>((args) => [schemas.addCustomProviderRequestSchema.parse(args[0])]),
		returns<void>(),
	),
	probeProvider: request(
		"models:probeProvider",
		argumentsOf<[request: ProbeCustomProviderRequest]>((args) => [
			schemas.probeCustomProviderRequestSchema.parse(args[0]),
		]),
		returns<EndpointProbeResult>(),
	),
	addModel: request(
		"models:addModel",
		argumentsOf<[request: AddCustomModelRequest]>((args) => [schemas.addCustomModelRequestSchema.parse(args[0])]),
		returns<void>(),
	),
	removeModel: request(
		"models:removeModel",
		argumentsOf<[request: RemoveCustomModelRequest]>((args) => [schemas.removeCustomModelRequestSchema.parse(args[0])]),
		returns<void>(),
	),
	removeProvider: request(
		"models:removeProvider",
		argumentsOf<[provider: string]>((args) => [schemas.providerIdSchema.parse(args[0])]),
		returns<void>(),
	),
	updateProvider: request(
		"models:updateProvider",
		argumentsOf<[request: UpdateCustomProviderRequest]>((args) => [
			schemas.updateCustomProviderRequestSchema.parse(args[0]),
		]),
		returns<void>(),
	),
	updateModel: request(
		"models:updateModel",
		argumentsOf<[request: UpdateCustomModelRequest]>((args) => [schemas.updateCustomModelRequestSchema.parse(args[0])]),
		returns<void>(),
	),
	refreshCatalogs: request("models:refreshCatalogs", noArguments, returns<ModelCatalogRefreshResult>()),
	cancelCatalogRefresh: request("models:cancelCatalogRefresh", noArguments, returns<void>()),
	loginStart: request(
		"models:loginStart",
		argumentsOf<[request: LoginStartRequest]>((args) => [schemas.loginStartRequestSchema.parse(args[0])]),
		returns<void>(),
	),
	loginRespond: request(
		"models:loginRespond",
		argumentsOf<[request: LoginRespondRequest]>((args) => [schemas.loginRespondRequestSchema.parse(args[0])]),
		returns<void>(),
	),
	loginCancel: request(
		"models:loginCancel",
		argumentsOf<[request: LoginCancelRequest]>((args) => [schemas.loginCancelRequestSchema.parse(args[0])]),
		returns<void>(),
	),
	onLoginEvent: event("models:login-event", returns<ModelLoginEventEnvelope>()),
	onChanged: event("models:changed", returns<null>()),
};
