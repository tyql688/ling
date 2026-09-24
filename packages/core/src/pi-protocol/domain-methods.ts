import { domainMethod } from "./method";
import {
	voiceProjectSchema,
	voiceConfigureRequestSchema,
	voiceTranscribeRequestSchema,
	voiceOverviewSchema,
	voiceTranscriptSchema,
} from "@ling/contracts/voice";
import type { EndpointProbeResult } from "@ling/contracts/model";
import {
	addCustomModelRequestSchema,
	addCustomProviderRequestSchema,
	loginCancelRequestSchema,
	loginRespondRequestSchema,
	loginStartRequestSchema,
	modelConfigurationRequestSchema,
	probeCustomProviderRequestSchema,
	projectModelCatalogRequestSchema,
	providerAuthTargetSchema,
	providerIdSchema,
	removeCustomModelRequestSchema,
	setProviderApiKeyRequestSchema,
	updateCustomModelRequestSchema,
	updateCustomProviderRequestSchema,
} from "@ling/contracts/model-requests";
import { ABSOLUTE_PATH_MAX_CHARS } from "@ling/contracts/path-bounds";
import type { SkillInfo, SkillsOverview } from "@ling/contracts/skill";
import {
	SKILL_CONTENT_MAX_BYTES,
	SKILL_EXTRA_PATH_MAX_CHARS,
	SKILL_RESOURCE_CONTENT_MAX_BYTES,
	SKILL_RESOURCE_RELATIVE_PATH_MAX_CHARS,
} from "@ling/contracts/skill";
import type { SessionMessage } from "@ling/contracts/session";
import { z } from "zod";
import * as outputs from "./domain-payload-schemas";
import { sessionMessagesSchema } from "./runtime-payload-schemas";
import { piSettingsUpdateSchema } from "./domain-request-validation";
import { piMethod, piVoidMethod } from "./method";
import type { PiWorkerProjectSnapshot, PiWorkerSessionDiscovery, PiWorkerSessionInfo } from "./protocol";
import {
	command,
	IO_REQUEST_TIMEOUT_MS,
	LIFECYCLE_REQUEST_TIMEOUT_MS,
	LONG_REQUEST_TIMEOUT_MS,
	recoverableQuery,
} from "./request-policy";
import { COLLECTION_MAX_ITEMS, fieldSchema } from "./runtime-payload-schemas";
// Keep discovery and project admission bounded inside the isolated worker.
const COLLECTION_CAPACITY = 100_000;
// Project-wide operations share the runtime registry admission capacity.
const PROJECT_CAPACITY = 64;
const projectPathSchema = z.string().min(1).max(ABSOLUTE_PATH_MAX_CHARS);
const projectPathsSchema = z.array(projectPathSchema).max(PROJECT_CAPACITY);
const fingerprintSchema = z.strictObject({
	size: z.number().int().nonnegative(),
	modifiedAtMs: z.number().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export const piDomainMethods = {
	"voice.read": domainMethod(
		piMethod(
			voiceProjectSchema,
			(value: unknown) => voiceOverviewSchema.parse(value),
			recoverableQuery({ timeoutMs: IO_REQUEST_TIMEOUT_MS }),
		),
		"readVoice",
		["cwd"],
		{ signal: true },
	),
	"voice.configure": domainMethod(
		piVoidMethod(voiceConfigureRequestSchema, command({ timeoutMs: LONG_REQUEST_TIMEOUT_MS })),
		"configureVoice",
		null,
		{ signal: true },
	),
	"voice.transcribe": domainMethod(
		piMethod(
			voiceTranscribeRequestSchema,
			(value: unknown) => voiceTranscriptSchema.parse(value),
			command({ timeoutMs: LONG_REQUEST_TIMEOUT_MS }),
		),
		"transcribeVoice",
		null,
		{ signal: true },
	),
	"agent.getInfo": domainMethod(
		piMethod(
			z.strictObject({}),
			(value: unknown) => {
				return outputs.agentInfoSchema.parse(value);
			},
			recoverableQuery(),
		),
		"getAgentInfo",
		[],
		{},
	),
	"host.prepareShutdown": domainMethod(
		piVoidMethod(z.strictObject({}), command({ timeoutMs: LIFECYCLE_REQUEST_TIMEOUT_MS })),
		"prepareShutdown",
		[],
		{},
	),
	"project.open": domainMethod(
		piMethod(
			z.strictObject({ cwd: projectPathSchema }),
			(value: unknown) => {
				return outputs.projectSnapshotSchema.parse(value) as PiWorkerProjectSnapshot;
			},
			command({ timeoutMs: LIFECYCLE_REQUEST_TIMEOUT_MS, deferHeartbeat: true }),
		),
		"openProject",
		["cwd"],
		{},
	),
	"project.inspect": domainMethod(
		piMethod(
			z.strictObject({ cwd: projectPathSchema }),
			(value: unknown) => {
				return outputs.projectSnapshotSchema.parse(value) as PiWorkerProjectSnapshot;
			},
			recoverableQuery({ timeoutMs: LIFECYCLE_REQUEST_TIMEOUT_MS, deferHeartbeat: true }),
		),
		"inspectProject",
		["cwd"],
		{},
	),
	"project.piConfig": domainMethod(
		piMethod(
			z.strictObject({ cwd: projectPathSchema }),
			(value: unknown) => {
				return outputs.projectPiConfigSchema.parse(value);
			},
			recoverableQuery(),
		),
		"projectPiConfig",
		["cwd"],
		{},
	),
	"project.close": domainMethod(
		piVoidMethod(z.strictObject({ cwd: projectPathSchema }), command({ timeoutMs: LIFECYCLE_REQUEST_TIMEOUT_MS })),
		"closeProject",
		["cwd"],
		{},
	),
	"project.reloadSettings": domainMethod(
		piVoidMethod(
			z.strictObject({ projectCwds: projectPathsSchema }),
			command({ timeoutMs: LIFECYCLE_REQUEST_TIMEOUT_MS, deferHeartbeat: true }),
		),
		"reloadProjectSettings",
		["projectCwds"],
		{},
	),
	"project.refreshSettingsSnapshots": domainMethod(
		piVoidMethod(
			z.strictObject({ projectCwds: projectPathsSchema }),
			command({
				timeoutMs: LIFECYCLE_REQUEST_TIMEOUT_MS,
				deferHeartbeat: true,
			}),
		),
		"refreshSettingsSnapshots",
		["projectCwds"],
		{},
	),
	"session.list": domainMethod(
		piMethod(
			z.strictObject({ cwd: projectPathSchema }),
			(value: unknown) => {
				return z.array(outputs.sessionInfoSchema).max(COLLECTION_MAX_ITEMS).parse(value) as PiWorkerSessionInfo[];
			},
			recoverableQuery({ timeoutMs: LIFECYCLE_REQUEST_TIMEOUT_MS, deferHeartbeat: true }),
		),
		"listSessions",
		["cwd"],
		{},
	),
	"session.discover": domainMethod(
		piMethod(
			z.strictObject({
				cwd: projectPathSchema,
				cachedFiles: z
					.array(z.strictObject({ path: projectPathSchema, fingerprint: fingerprintSchema }))
					.max(COLLECTION_CAPACITY),
			}),
			(value: unknown) => {
				return z
					.array(outputs.sessionDiscoverySchema)
					.max(COLLECTION_MAX_ITEMS)
					.parse(value) as PiWorkerSessionDiscovery[];
			},
			recoverableQuery({ timeoutMs: LIFECYCLE_REQUEST_TIMEOUT_MS, deferHeartbeat: true }),
		),
		"discoverSessions",
		["cwd", "cachedFiles"],
		{},
	),
	"session.readArchived": domainMethod(
		piMethod(
			z.strictObject({
				cwd: projectPathSchema,
				sessionFilePath: projectPathSchema,
				markdownWidth: z.number().int().min(0).max(10_000),
			}),
			(value: unknown) => sessionMessagesSchema.parse(value) as SessionMessage[],
			recoverableQuery({ timeoutMs: LIFECYCLE_REQUEST_TIMEOUT_MS, deferHeartbeat: true }),
		),
		"readArchivedSession",
		["cwd", "sessionFilePath", "markdownWidth"],
		{},
	),
	"model.listProviders": domainMethod(
		piMethod(
			z.strictObject({}),
			(value: unknown) => {
				return outputs.providerCatalogSchema.parse(value);
			},
			recoverableQuery(),
		),
		"listProviders",
		[],
		{},
	),
	"model.getConfiguration": domainMethod(
		piMethod(
			modelConfigurationRequestSchema,
			(value: unknown) => {
				return outputs.modelConfigurationSchema.parse(value);
			},
			recoverableQuery(),
		),
		"getModelConfiguration",
		null,
		{},
	),
	"model.getProviderQuotas": domainMethod(
		piMethod(
			z.strictObject({}),
			(value: unknown) => {
				return outputs.providerQuotaSnapshotSchema.parse(value);
			},
			recoverableQuery({
				timeoutMs: LIFECYCLE_REQUEST_TIMEOUT_MS,
				deferHeartbeat: true,
			}),
		),
		"getProviderQuotas",
		[],
		{ signal: true },
	),
	"model.listProjectModels": domainMethod(
		piMethod(
			projectModelCatalogRequestSchema,
			(value: unknown) => {
				return outputs.projectModelCatalogSchema.parse(value);
			},
			recoverableQuery(),
		),
		"listProjectModels",
		["cwd"],
		{},
	),
	"model.getApiKey": domainMethod(
		piMethod(
			providerAuthTargetSchema,
			(value: unknown) => {
				return fieldSchema.nullable().parse(value);
			},
			recoverableQuery(),
		),
		"getApiKey",
		null,
		{},
	),
	"model.setApiKey": domainMethod(
		piVoidMethod(setProviderApiKeyRequestSchema, command()),
		"setApiKey",
		["provider", "key"],
		{},
	),
	"model.removeAuth": domainMethod(piVoidMethod(providerAuthTargetSchema, command()), "removeAuth", null, {}),
	"model.addProvider": domainMethod(piVoidMethod(addCustomProviderRequestSchema, command()), "addProvider", null, {}),
	"model.addModel": domainMethod(piVoidMethod(addCustomModelRequestSchema, command()), "addModel", null, {}),
	"model.removeModel": domainMethod(
		piVoidMethod(removeCustomModelRequestSchema, command()),
		"removeModel",
		["provider", "modelId"],
		{},
	),
	"model.removeProvider": domainMethod(
		piVoidMethod(z.strictObject({ provider: providerIdSchema }), command()),
		"removeProvider",
		["provider"],
		{},
	),
	"model.probeProvider": domainMethod(
		piMethod(
			probeCustomProviderRequestSchema,
			(value: unknown) => {
				return outputs.endpointProbeSchema.parse(value) as EndpointProbeResult;
			},
			recoverableQuery(),
		),
		"probeProvider",
		["baseUrl", "apiKey"],
		{},
	),
	"model.updateProvider": domainMethod(
		piVoidMethod(updateCustomProviderRequestSchema, command()),
		"updateProvider",
		null,
		{},
	),
	"model.updateModel": domainMethod(piVoidMethod(updateCustomModelRequestSchema, command()), "updateModel", null, {}),
	"model.refreshCatalogs": domainMethod(
		piMethod(
			z.strictObject({}),
			(value: unknown) => {
				return outputs.modelCatalogRefreshSchema.parse(value);
			},
			command({ timeoutMs: LIFECYCLE_REQUEST_TIMEOUT_MS }),
		),
		"refreshModelCatalogs",
		[],
		{},
	),
	"model.cancelCatalogRefresh": domainMethod(
		piVoidMethod(z.strictObject({}), command()),
		"cancelModelCatalogRefresh",
		[],
		{},
	),
	"model.loginStart": domainMethod(
		piVoidMethod(loginStartRequestSchema, command({ timeoutMs: LONG_REQUEST_TIMEOUT_MS })),
		"startLogin",
		["flowId", "provider", "method", "cwd"],
		{},
	),
	"model.loginRespond": domainMethod(
		piVoidMethod(loginRespondRequestSchema, command()),
		"respondLogin",
		["flowId", "requestId", "value"],
		{},
	),
	"model.loginCancel": domainMethod(piVoidMethod(loginCancelRequestSchema, command()), "cancelLogin", ["flowId"], {}),
	"model.reconcileCredential": domainMethod(
		piVoidMethod(z.strictObject({ cwd: projectPathSchema.nullable() }), command()),
		"reconcileCredential",
		["cwd"],
		{},
	),
	"settings.getProxy": domainMethod(
		piMethod(
			z.strictObject({}),
			(value: unknown) => {
				return fieldSchema.nullable().parse(value);
			},
			recoverableQuery(),
		),
		"getProxy",
		[],
		{},
	),
	"settings.setProxy": domainMethod(
		piVoidMethod(
			z.strictObject({ proxy: z.string().max(4_096).nullable() }),
			command({ timeoutMs: IO_REQUEST_TIMEOUT_MS }),
		),
		"setProxy",
		["proxy"],
		{},
	),
	"settings.get": domainMethod(
		piMethod(
			z.strictObject({}),
			(value: unknown) => {
				return outputs.settingsSchema.parse(value);
			},
			recoverableQuery({ deferHeartbeat: true }),
		),
		"getSettings",
		[],
		{},
	),
	"settings.getRecoveryStatus": domainMethod(
		piMethod(
			z.strictObject({}),
			(value: unknown) => {
				return outputs.settingsRecoverySchema.parse(value);
			},
			recoverableQuery({ deferHeartbeat: true }),
		),
		"getSettingsRecoveryStatus",
		[],
		{},
	),
	"settings.repairHttpIdleTimeout": domainMethod(
		piVoidMethod(z.strictObject({}), command({ timeoutMs: IO_REQUEST_TIMEOUT_MS })),
		"repairHttpIdleTimeout",
		[],
		{},
	),
	"settings.update": domainMethod(
		piVoidMethod(z.strictObject({ update: piSettingsUpdateSchema }), command({ timeoutMs: IO_REQUEST_TIMEOUT_MS })),
		"updateSettings",
		["update"],
		{},
	),
	"skills.overview": domainMethod(
		piMethod(
			z.strictObject({ projectCwds: projectPathsSchema }),
			(value: unknown) => {
				return outputs.skillsOverviewSchema.parse(value) as SkillsOverview;
			},
			recoverableQuery({ timeoutMs: IO_REQUEST_TIMEOUT_MS }),
		),
		"readSkillsOverview",
		["projectCwds"],
		{},
	),
	"skills.project": domainMethod(
		piMethod(
			z.strictObject({ cwd: projectPathSchema }),
			(value: unknown) => {
				return z.array(outputs.skillInfoSchema).max(COLLECTION_MAX_ITEMS).parse(value) as SkillInfo[];
			},
			recoverableQuery({ timeoutMs: IO_REQUEST_TIMEOUT_MS }),
		),
		"readProjectSkills",
		["cwd"],
		{},
	),
	"skills.addGlobalPath": domainMethod(
		piVoidMethod(
			z.strictObject({ path: z.string().max(SKILL_EXTRA_PATH_MAX_CHARS) }),
			command({ timeoutMs: IO_REQUEST_TIMEOUT_MS }),
		),
		"addGlobalSkillPath",
		["path"],
		{},
	),
	"skills.removeGlobalPath": domainMethod(
		piVoidMethod(
			z.strictObject({ path: z.string().max(SKILL_EXTRA_PATH_MAX_CHARS) }),
			command({ timeoutMs: IO_REQUEST_TIMEOUT_MS }),
		),
		"removeGlobalSkillPath",
		["path"],
		{},
	),
	"skills.setBuiltinEnabled": domainMethod(
		piVoidMethod(z.strictObject({ enabled: z.boolean() }), command()),
		"setBuiltinSkillsEnabled",
		["enabled"],
		{},
	),
	"skills.setSkillEnabled": domainMethod(
		piVoidMethod(z.strictObject({ name: z.string().min(1).max(64), enabled: z.boolean() }), command()),
		"setSkillEnabled",
		["name", "enabled"],
		{},
	),
	"skills.readContent": domainMethod(
		piMethod(
			z.strictObject({ filePath: projectPathSchema }),
			(value: unknown) => {
				return z.string().max(SKILL_CONTENT_MAX_BYTES).parse(value);
			},
			recoverableQuery({ timeoutMs: IO_REQUEST_TIMEOUT_MS }),
		),
		"readSkillContent",
		["filePath"],
		{},
	),
	"skills.listResources": domainMethod(
		piMethod(
			z.strictObject({ filePath: projectPathSchema }),
			(value: unknown) => {
				return outputs.skillResourcesSchema.parse(value);
			},
			recoverableQuery({ timeoutMs: IO_REQUEST_TIMEOUT_MS }),
		),
		"listSkillResources",
		["filePath"],
		{},
	),
	"skills.readResource": domainMethod(
		piMethod(
			z.strictObject({
				filePath: projectPathSchema,
				relativePath: z.string().max(SKILL_RESOURCE_RELATIVE_PATH_MAX_CHARS),
			}),
			(value: unknown) => {
				return z.string().max(SKILL_RESOURCE_CONTENT_MAX_BYTES).parse(value);
			},
			recoverableQuery({ timeoutMs: IO_REQUEST_TIMEOUT_MS }),
		),
		"readSkillResource",
		["filePath", "relativePath"],
		{},
	),
	"skills.resolveResourcePath": domainMethod(
		piMethod(
			z.strictObject({
				filePath: projectPathSchema,
				relativePath: z.string().max(SKILL_RESOURCE_RELATIVE_PATH_MAX_CHARS),
			}),
			(value: unknown) => {
				return outputs.absolutePathSchema.parse(value);
			},
			recoverableQuery({ timeoutMs: IO_REQUEST_TIMEOUT_MS }),
		),
		"resolveSkillResourcePath",
		["filePath", "relativePath"],
		{},
	),
};
