import {
	MODEL_LOGIN_RESPONSE_MAX_CHARS,
	modelCompatSchema,
	modelOptionsSchema,
	modelSamplingParamsSchema,
} from "@ling/contracts/model";
import { ABSOLUTE_PATH_MAX_CHARS } from "@ling/contracts/path-bounds";
import type { PiSettingsSnapshot } from "@ling/contracts/pi-settings";
import {
	PI_BUILT_IN_TOOL_NAMES,
	PI_COMPACTION_TOKEN_MAX,
	PI_COMPACTION_TOKEN_MIN,
	PI_CACHE_WARMING_MODES,
	PI_RETRY_MAX_DELAY_MS_MAX,
	piCompactionModelOverridesSchema,
	PI_RETRY_BASE_DELAY_MS_MAX,
	PI_RETRY_BASE_DELAY_MS_MIN,
	PI_RETRY_MAX_RETRIES_MAX,
	PI_RETRY_MAX_RETRIES_MIN,
	PI_SETTINGS_SHELL_PREFIX_MAX_CHARS,
} from "@ling/contracts/pi-settings";
import { THINKING_LEVELS } from "@ling/contracts/session";
import { SKILL_EXTRA_PATH_MAX_CHARS, SKILL_RESOURCE_MAX_ENTRIES } from "@ling/contracts/skill";
import { z } from "zod";
import { absolutePathSchema as createAbsolutePathSchema } from "../paths";
import type { PiWorkerEvent } from "./protocol";
import { PI_WORKER_PROTOCOL_VERSION } from "./wire-format";

import {
	COLLECTION_MAX_ITEMS,
	countSchema,
	diagnosticSchema,
	fieldSchema,
	idSchema,
	textSchema,
} from "./runtime-payload-schemas";

const timestampSchema = z.number().int().nonnegative();
const fileTimestampSchema = z.number().nonnegative().max(Number.MAX_SAFE_INTEGER);
/** A single provider card cannot usefully expose more independent windows or account amounts. */
const PROVIDER_QUOTA_METRIC_MAX_ITEMS = 64;
export const absolutePathSchema = createAbsolutePathSchema("Pi worker path");
const configuredSkillPathSchema = z
	.string()
	.min(1)
	.max(SKILL_EXTRA_PATH_MAX_CHARS)
	.refine((value) => !value.includes("\0"), "Pi skill path must not contain null bytes");

export const agentInfoSchema = z.strictObject({ agentDir: absolutePathSchema, piVersion: fieldSchema });
export const projectSnapshotSchema = z.strictObject({
	cwd: absolutePathSchema,
	diagnostics: z.array(diagnosticSchema).max(COLLECTION_MAX_ITEMS),
});

export const projectPiConfigSchema = z.strictObject({
	path: absolutePathSchema,
	exists: z.boolean(),
	trusted: z.boolean(),
	settings: z.record(z.string(), z.unknown()),
});

const sessionFingerprintSchema = z.strictObject({ size: countSchema, modifiedAtMs: fileTimestampSchema });
export const sessionInfoSchema = z.strictObject({
	path: absolutePathSchema,
	id: idSchema,
	cwd: z.string().max(ABSOLUTE_PATH_MAX_CHARS),
	name: textSchema.optional(),
	parentSessionPath: absolutePathSchema.optional(),
	manualFork: z.boolean().optional(),
	createdAt: timestampSchema,
	modifiedAt: timestampSchema,
	messageCount: countSchema,
	firstMessage: textSchema,
});
export const sessionDiscoverySchema = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("cached"), path: absolutePathSchema, fingerprint: sessionFingerprintSchema }),
	z.strictObject({
		kind: z.literal("loaded"),
		path: absolutePathSchema,
		info: sessionInfoSchema,
		fingerprint: sessionFingerprintSchema.nullable(),
	}),
]);

const providerModelDefinitionSchema = z.strictObject({
	name: fieldSchema.nullable(),
	contextWindow: countSchema.nullable(),
	maxTokens: countSchema.nullable(),
	reasoning: z.boolean(),
	samplingParams: modelSamplingParamsSchema,
	compat: modelCompatSchema,
	options: modelOptionsSchema,
});
export const modelConfigurationSchema = z.strictObject({
	effective: modelSamplingParamsSchema.refine((value) => value !== null),
	configured: modelSamplingParamsSchema,
	overrides: modelSamplingParamsSchema,
	providerDefaults: modelSamplingParamsSchema.refine((value) => value !== null),
	template: providerModelDefinitionSchema,
	source: z.enum(["builtin", "custom", "extension"]),
	hasModelHeaders: z.boolean(),
});
const providerModelSchema = z.strictObject({
	id: fieldSchema,
	name: fieldSchema,
	contextWindow: countSchema,
	maxTokens: countSchema,
	reasoning: z.boolean(),
	definition: providerModelDefinitionSchema.nullable(),
});
const providerSummarySchema = z.strictObject({
	id: fieldSchema,
	name: fieldSchema.nullable(),
	displayName: fieldSchema,
	credentialStatus: z.enum(["known", "unknown"]),
	configured: z.boolean(),
	source: z.enum(["stored", "runtime", "environment", "fallback", "models_json_key", "models_json_command"]).nullable(),
	sourceLabel: fieldSchema.nullable(),
	credentialType: z.enum(["oauth", "api_key"]).nullable(),
	authMethods: z.strictObject({
		apiKey: z.strictObject({ name: fieldSchema, interactive: z.boolean() }).nullable(),
		oauth: z.strictObject({ name: fieldSchema, loginLabel: fieldSchema.nullable() }).nullable(),
	}),
	projectExtension: z.boolean(),
	projectCwd: absolutePathSchema.nullable(),
	authConflict: z.boolean(),
	custom: z.boolean(),
	baseUrl: fieldSchema.nullable(),
	api: fieldSchema.nullable(),
	compat: modelCompatSchema,
	models: z.array(providerModelSchema).max(COLLECTION_MAX_ITEMS),
});
export const providerCatalogSchema = z.strictObject({
	providers: z.array(providerSummarySchema).max(COLLECTION_MAX_ITEMS),
	configError: textSchema.nullable(),
});
const providerQuotaWindowSchema = z.strictObject({
	id: fieldSchema,
	kind: z.enum(["rolling", "weekly", "model", "premium", "chat", "other"]),
	label: fieldSchema.nullable(),
	usedPercent: z.number().nonnegative().nullable(),
	used: z.number().nullable(),
	limit: z.number().nonnegative().nullable(),
	remaining: z.number().nullable(),
	unit: fieldSchema.nullable(),
	durationSeconds: z.number().positive().nullable(),
	resetAt: timestampSchema.nullable(),
	unlimited: z.boolean(),
});
const providerQuotaAmountSchema = z.strictObject({
	kind: z.enum(["balance", "remaining", "spend"]),
	period: z.enum(["day", "week", "month", "total"]).nullable(),
	value: z.number(),
	limit: z.number().nonnegative().nullable(),
	unit: fieldSchema,
});
export const providerQuotaSnapshotSchema = z.strictObject({
	generatedAt: timestampSchema,
	providers: z
		.array(
			z.strictObject({
				id: fieldSchema,
				name: fieldSchema,
				status: z.enum(["available", "unsupported", "error"]),
				plan: fieldSchema.nullable(),
				windows: z.array(providerQuotaWindowSchema).max(PROVIDER_QUOTA_METRIC_MAX_ITEMS),
				amounts: z.array(providerQuotaAmountSchema).max(PROVIDER_QUOTA_METRIC_MAX_ITEMS),
				error: z.enum(["authentication", "rate-limit", "timeout", "network", "service", "invalid-response"]).nullable(),
			}),
		)
		.max(COLLECTION_MAX_ITEMS),
});
const modelInfoSchema = z.strictObject({
	provider: fieldSchema,
	providerName: fieldSchema,
	id: fieldSchema,
	name: fieldSchema,
	reasoning: z.boolean(),
	availableThinkingLevels: z.array(z.enum(THINKING_LEVELS)).max(THINKING_LEVELS.length),
	contextWindow: countSchema,
});
export const projectModelCatalogSchema = z.strictObject({
	cwd: absolutePathSchema,
	models: z.array(modelInfoSchema).max(COLLECTION_MAX_ITEMS),
	extensionProviders: z.array(providerSummarySchema).max(COLLECTION_MAX_ITEMS),
	configError: textSchema.nullable(),
});
export const endpointProbeSchema = z.discriminatedUnion("ok", [
	z.strictObject({ ok: z.literal(true), modelCount: countSchema.nullable() }),
	z.strictObject({
		ok: z.literal(false),
		reason: z.enum(["unreachable", "timeout", "auth", "http"]),
		status: countSchema.optional(),
	}),
]);
export const modelCatalogRefreshSchema = z.strictObject({
	aborted: z.boolean(),
	timedOut: z.boolean(),
	errors: z.array(z.strictObject({ provider: fieldSchema, message: textSchema })).max(COLLECTION_MAX_ITEMS),
	adoptedModels: z.array(z.strictObject({ provider: fieldSchema, modelId: fieldSchema })).max(COLLECTION_MAX_ITEMS),
	backupPath: absolutePathSchema.nullable(),
});

const modelLoginEventSchema = z.discriminatedUnion("type", [
	z.strictObject({ type: z.literal("auth-url"), url: fieldSchema, instructions: textSchema.nullable() }),
	z.strictObject({ type: z.literal("device-code"), userCode: fieldSchema, verificationUri: fieldSchema }),
	z.strictObject({
		type: z.literal("info"),
		message: textSchema,
		links: z.array(z.strictObject({ url: fieldSchema, label: fieldSchema.nullable() })).max(64),
	}),
	z.strictObject({
		type: z.literal("prompt"),
		requestId: idSchema,
		message: textSchema,
		placeholder: textSchema.nullable(),
		secret: z.boolean(),
	}),
	z.strictObject({
		type: z.literal("manual-code"),
		requestId: idSchema,
		message: textSchema,
		placeholder: textSchema.nullable(),
	}),
	z.strictObject({
		type: z.literal("select"),
		requestId: idSchema,
		message: textSchema,
		options: z
			.array(z.strictObject({ id: fieldSchema, label: fieldSchema, description: textSchema.nullable() }))
			.max(256),
	}),
	z.strictObject({ type: z.literal("request-cancelled"), requestId: idSchema }),
	z.strictObject({ type: z.literal("progress"), message: textSchema }),
	z.strictObject({
		type: z.literal("done"),
		ok: z.boolean(),
		error: z.string().max(MODEL_LOGIN_RESPONSE_MAX_CHARS).nullable(),
		credentialSynchronization: z.enum(["ready", "recovered", "pending"]).nullable(),
	}),
]);

export const settingsSchema: z.ZodType<PiSettingsSnapshot> = z.strictObject({
	defaultProvider: fieldSchema.nullable(),
	defaultModel: fieldSchema.nullable(),
	defaultThinkingLevel: z.enum(THINKING_LEVELS).nullable(),
	compactionEnabled: z.boolean(),
	// getPiSettings() normalizes raw settings.json values into this range on read;
	// only the write path rejects out-of-range input.
	compactionReserveTokens: z.number().int().min(PI_COMPACTION_TOKEN_MIN).max(PI_COMPACTION_TOKEN_MAX),
	compactionKeepRecentTokens: z.number().int().min(PI_COMPACTION_TOKEN_MIN).max(PI_COMPACTION_TOKEN_MAX),
	compactionModelOverrides: piCompactionModelOverridesSchema,
	cacheWarming: z.enum(PI_CACHE_WARMING_MODES),
	retryEnabled: z.boolean(),
	retryMaxRetries: z.number().int().min(PI_RETRY_MAX_RETRIES_MIN).max(PI_RETRY_MAX_RETRIES_MAX),
	retryBaseDelayMs: z.number().int().min(PI_RETRY_BASE_DELAY_MS_MIN).max(PI_RETRY_BASE_DELAY_MS_MAX),
	retryMaxAgentDelayMs: z.number().int().nonnegative().max(PI_RETRY_MAX_DELAY_MS_MAX),
	blockImages: z.boolean(),
	imageAutoResize: z.boolean(),
	shellCommandPrefix: z.string().max(PI_SETTINGS_SHELL_PREFIX_MAX_CHARS).nullable(),
	defaultProjectTrust: z.enum(["ask", "always", "never"]),
	steeringMode: z.enum(["all", "one-at-a-time"]),
	followUpMode: z.enum(["all", "one-at-a-time"]),
	shellPath: fieldSchema.nullable(),
	npmCommand: fieldSchema.nullable(),
	installTelemetry: z.boolean(),
	analytics: z.boolean(),
	httpIdleTimeoutMs: z.number().nonnegative(),
	enableSkillCommands: z.boolean(),
	defaultTools: z.array(z.enum(PI_BUILT_IN_TOOL_NAMES)).max(PI_BUILT_IN_TOOL_NAMES.length),
});
export const settingsRecoverySchema = z.discriminatedUnion("status", [
	z.strictObject({ status: z.literal("ready") }),
	z.strictObject({
		status: z.literal("recoveryRequired"),
		code: z.literal("INVALID_HTTP_IDLE_TIMEOUT"),
		field: z.literal("httpIdleTimeoutMs"),
	}),
	z.strictObject({ status: z.literal("unavailable"), code: z.literal("PI_SETTINGS_READ_FAILED") }),
]);

export const skillInfoSchema = z.strictObject({
	name: fieldSchema,
	description: textSchema,
	filePath: absolutePathSchema,
	source: textSchema,
	scope: z.enum(["user", "project", "temporary"]),
	origin: z.enum(["package", "top-level"]),
	projectCwd: absolutePathSchema.nullable(),
	builtin: z.boolean(),
	enabled: z.boolean(),
	disableModelInvocation: z.boolean(),
	// Absent for a skill the `skills` CLI never recorded, which is most of them.
	provenance: z.strictObject({ source: fieldSchema }).optional(),
});
export const skillsOverviewSchema = z.strictObject({
	skills: z.array(skillInfoSchema).max(COLLECTION_MAX_ITEMS),
	diagnostics: z
		.array(
			z.strictObject({
				type: z.enum(["warning", "error", "collision"]),
				message: textSchema,
				path: absolutePathSchema.nullable(),
			}),
		)
		.max(COLLECTION_MAX_ITEMS),
	// Pi settings preserve user-facing forms such as ~/.claude/skills; unlike resolved
	// resource paths, these configuration entries are not required to be absolute.
	extraPaths: z.array(configuredSkillPathSchema).max(COLLECTION_MAX_ITEMS),
	enableSkillCommands: z.boolean(),
	globalSkillsDir: absolutePathSchema,
	builtinSkillsEnabled: z.boolean(),
});
export const skillResourcesSchema = z.strictObject({
	resources: z
		.array(
			z.strictObject({
				relativePath: fieldSchema,
				kind: z.enum(["script", "reference", "asset"]),
				contentKind: z.enum(["text", "binary"]),
				byteLength: countSchema,
			}),
		)
		.max(SKILL_RESOURCE_MAX_ENTRIES),
	truncated: z.boolean(),
});

export function parsePiWorkerDomainEvent(value: unknown): PiWorkerEvent {
	const base = {
		protocolVersion: z.literal(PI_WORKER_PROTOCOL_VERSION),
		generation: countSchema.positive(),
		sequence: countSchema.positive(),
	};
	return z
		.discriminatedUnion("kind", [
			z.strictObject({ ...base, kind: z.literal("modelCatalogChanged") }),
			z.strictObject({ ...base, kind: z.literal("modelLoginEvent"), flowId: idSchema, event: modelLoginEventSchema }),
			z.strictObject({ ...base, kind: z.literal("modelOpenExternal"), flowId: idSchema, url: fieldSchema }),
		])
		.parse(value);
}
