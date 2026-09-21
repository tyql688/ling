import { argumentsOf, noArguments, request, returns } from "./procedure";
import type { PiResourceReloadSummary } from "./session";
import type {
	BuiltinSkillsMasterRequest,
	RevealSkillRequest,
	SkillContentRequest,
	SkillEnabledRequest,
	SkillInfo,
	SkillPathMutationResponse,
	SkillPathRequest,
	SkillProjectRequest,
	SkillResourceListRequest,
	SkillResourceRequest,
	SkillResourcesSnapshot,
	SkillsOverview,
	SkillToggleMutationResponse,
	SkillUpdateRunRequest,
	SkillUpdateRunResult,
	SkillUpdateStatus,
} from "./skill";
import * as schemas from "./skill-requests";
export const skillsProcedures = {
	overview: request("skills:overview", noArguments, returns<SkillsOverview>()),
	reload: request("skills:reload", noArguments, returns<PiResourceReloadSummary>()),
	projectSkills: request(
		"skills:project",
		argumentsOf<[request: SkillProjectRequest]>((args) => [schemas.skillProjectRequestSchema.parse(args[0])]),
		returns<SkillInfo[]>(),
	),
	reveal: request(
		"skills:reveal",
		argumentsOf<[request: RevealSkillRequest]>((args) => [schemas.skillFilePathSchema.parse(args[0])]),
		returns<string>(),
	),
	readContent: request(
		"skills:readContent",
		argumentsOf<[request: SkillContentRequest]>((args) => [schemas.skillFilePathSchema.parse(args[0])]),
		returns<string>(),
	),
	listResources: request(
		"skills:listResources",
		argumentsOf<[request: SkillResourceListRequest]>((args) => [schemas.skillFilePathSchema.parse(args[0])]),
		returns<SkillResourcesSnapshot>(),
	),
	readResource: request(
		"skills:readResource",
		argumentsOf<[request: SkillResourceRequest]>((args) => [schemas.skillResourceRequestSchema.parse(args[0])]),
		returns<string>(),
	),
	revealResource: request(
		"skills:revealResource",
		argumentsOf<[request: SkillResourceRequest]>((args) => [schemas.skillResourceRequestSchema.parse(args[0])]),
		returns<string>(),
	),
	openGlobalDir: request("skills:openGlobalDir", noArguments, returns<{ dir: string }>()),
	addPath: request(
		"skills:addPath",
		argumentsOf<[path: string]>((args) => {
			const parsed = schemas.skillPathRequestSchema.parse({ path: args[0] });
			return [parsed.path];
		}),
		returns<SkillPathMutationResponse>(),
	),
	removePath: request(
		"skills:removePath",
		argumentsOf<[request: SkillPathRequest]>((args) => [schemas.skillPathRequestSchema.parse(args[0])]),
		returns<SkillPathMutationResponse>(),
	),
	setBuiltinEnabled: request(
		"skills:setBuiltinEnabled",
		argumentsOf<[request: BuiltinSkillsMasterRequest]>((args) => [schemas.builtinMasterRequestSchema.parse(args[0])]),
		returns<SkillToggleMutationResponse>(),
	),
	setSkillEnabled: request(
		"skills:setSkillEnabled",
		argumentsOf<[request: SkillEnabledRequest]>((args) => [schemas.skillEnabledRequestSchema.parse(args[0])]),
		returns<SkillToggleMutationResponse>(),
	),
	checkUpdates: request("skills:checkUpdates", noArguments, returns<SkillUpdateStatus[]>()),
	runUpdates: request(
		"skills:runUpdates",
		argumentsOf<[request: SkillUpdateRunRequest]>((args) => [schemas.skillUpdateRunSchema.parse(args[0])]),
		returns<SkillUpdateRunResult>(),
	),
};
