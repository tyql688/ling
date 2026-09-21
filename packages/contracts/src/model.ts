import { z } from "zod";
import { boundedJsonObjectValidationError, type BoundedJsonLimits, type BoundedJsonObject } from "./bounded-json";
import type * as requestSchemas from "./model-requests";
import type { ModelInfo } from "./session";

// Transport bounds are intentionally generous for real provider/model identifiers and
// secrets while preventing unbounded settings/login payloads from crossing IPC.
/** Max length of a provider id; real ids are short, so 128 is ample and keeps unbounded settings fields off IPC. */
export const MODEL_PROVIDER_ID_MAX_CHARS = 128;
/** Max length of a model id; accommodates long vendor ids while bounding models.json/IPC payloads. */
export const MODEL_ID_MAX_CHARS = 512;
/** Max length of a display name; same tier as the model id so UI labels can't grow unbounded. */
export const MODEL_DISPLAY_NAME_MAX_CHARS = 512;
/** 64K cap on an API key/secret field; ample for real secrets and rejects unbounded pastes that would blow up auth writes. */
export const MODEL_SECRET_MAX_CHARS = 65_536;
/** 64K cap on an interactive login response text; bounds user input during OAuth/interactive login. */
export const MODEL_LOGIN_RESPONSE_MAX_CHARS = 65_536;
/** Max length of a login requestId; correlates login-flow events and rejects abnormally long correlation ids. */
export const MODEL_LOGIN_REQUEST_ID_MAX_CHARS = 512;
/** Advanced sampling configuration is deliberately much smaller than models.json itself. */
export const MODEL_SAMPLING_PARAMS_LIMITS: BoundedJsonLimits = {
	maxDepth: 8,
	maxNodes: 512,
	maxObjectKeys: 128,
	maxArrayItems: 256,
	maxKeyChars: 256,
	maxStringChars: 16_384,
	maxBytes: 64 * 1024,
};
/** Model compatibility overrides use the same bounded-object budget as advanced sampling parameters. */
export const MODEL_COMPAT_LIMITS: BoundedJsonLimits = { ...MODEL_SAMPLING_PARAMS_LIMITS };

const compatBooleanSchema = z.boolean().optional();
const sessionAffinityFormatSchema = z.enum(["openai", "openai-nosession", "openrouter"]);
const chatTemplateVariableSchema = z.looseObject({
	$var: z.enum(["thinking.enabled", "thinking.effort", "thinking.budget"]),
	omitWhenOff: z.boolean().optional(),
});
const chatTemplateValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null(), chatTemplateVariableSchema]);
const percentileCutoffsSchema = z.looseObject({
	p50: z.number().optional(),
	p75: z.number().optional(),
	p90: z.number().optional(),
	p99: z.number().optional(),
});
const openRouterRoutingSchema = z.looseObject({
	allow_fallbacks: z.boolean().optional(),
	require_parameters: z.boolean().optional(),
	data_collection: z.enum(["deny", "allow"]).optional(),
	zdr: z.boolean().optional(),
	enforce_distillable_text: z.boolean().optional(),
	order: z.array(z.string()).optional(),
	only: z.array(z.string()).optional(),
	ignore: z.array(z.string()).optional(),
	quantizations: z.array(z.string()).optional(),
	sort: z
		.union([
			z.string(),
			z.looseObject({
				by: z.string().optional(),
				partition: z.string().nullable().optional(),
			}),
		])
		.optional(),
	max_price: z
		.looseObject({
			prompt: z.union([z.number(), z.string()]).optional(),
			completion: z.union([z.number(), z.string()]).optional(),
			image: z.union([z.number(), z.string()]).optional(),
			audio: z.union([z.number(), z.string()]).optional(),
			request: z.union([z.number(), z.string()]).optional(),
		})
		.optional(),
	preferred_min_throughput: z.union([z.number(), percentileCutoffsSchema]).optional(),
	preferred_max_latency: z.union([z.number(), percentileCutoffsSchema]).optional(),
});
const vercelGatewayRoutingSchema = z.looseObject({
	only: z.array(z.string()).optional(),
	order: z.array(z.string()).optional(),
});
const fallbackCostRatesSchema = {
	input: z.number(),
	output: z.number(),
	cacheRead: z.number(),
	cacheWrite: z.number(),
};
const fallbackCostTierSchema = z.looseObject({
	inputTokensAbove: z.number(),
	...fallbackCostRatesSchema,
});
const fallbackCostSchema = z.looseObject({
	...fallbackCostRatesSchema,
	tiers: z.array(fallbackCostTierSchema).optional(),
});

/** Pi's open-object compat union can accept a malformed API-specific field
 * through a sibling branch. Validate every currently known field here while
 * retaining unknown keys for forwards-compatible models.json round trips. */
const modelCompatKnownFieldsSchema = z.looseObject({
	supportsStore: compatBooleanSchema,
	supportsDeveloperRole: compatBooleanSchema,
	supportsReasoningEffort: compatBooleanSchema,
	supportsUsageInStreaming: compatBooleanSchema,
	supportsFinishReason: compatBooleanSchema,
	maxTokensField: z.enum(["max_completion_tokens", "max_tokens"]).optional(),
	requiresToolResultName: compatBooleanSchema,
	requiresAssistantAfterToolResult: compatBooleanSchema,
	requiresThinkingAsText: compatBooleanSchema,
	requiresReasoningContentOnAssistantMessages: compatBooleanSchema,
	thinkingFormat: z
		.enum([
			"openai",
			"openrouter",
			"together",
			"baseten",
			"deepseek",
			"zai",
			"qwen",
			"chat-template",
			"qwen-chat-template",
			"string-thinking",
			"ant-ling",
		])
		.optional(),
	chatTemplateKwargs: z.record(z.string(), chatTemplateValueSchema).optional(),
	chatTemplateArgs: z.record(z.string(), chatTemplateValueSchema).optional(),
	openRouterRouting: openRouterRoutingSchema.optional(),
	vercelGatewayRouting: vercelGatewayRoutingSchema.optional(),
	zaiToolStream: compatBooleanSchema,
	thinkingTokenBudgetField: z.enum(["thinking_token_budget", "thinking_budget", "thinking_budget_tokens"]).optional(),
	supportsThinkingTokenBudget: compatBooleanSchema,
	supportsOpenAIGrammarTools: compatBooleanSchema,
	supportsStrictMode: compatBooleanSchema,
	cacheControlFormat: z.literal("anthropic").optional(),
	sendSessionAffinityHeaders: compatBooleanSchema,
	deferredToolsMode: z.literal("kimi").optional(),
	sessionAffinityFormat: sessionAffinityFormatSchema.optional(),
	supportsLongCacheRetention: compatBooleanSchema,
	vllmPriority: z.number().optional(),
	supportsAdditionalTools: compatBooleanSchema,
	supportsToolSearch: compatBooleanSchema,
	supportsExplicitPromptCacheMode: compatBooleanSchema,
	supportsMaxOutputTokens: compatBooleanSchema,
	supportsEagerToolInputStreaming: compatBooleanSchema,
	supportsCacheControlOnTools: compatBooleanSchema,
	supportsTemperature: compatBooleanSchema,
	forceAdaptiveThinking: compatBooleanSchema,
	allowEmptySignature: compatBooleanSchema,
	supportsStrictTools: compatBooleanSchema,
	supportsMidConvoEffort: compatBooleanSchema,
	supportsMidConvoSystemMessages: compatBooleanSchema,
	supportsMidConvoToolAdditions: compatBooleanSchema,
	supportsMidConvoToolChanges: compatBooleanSchema,
	allowedFallbackModels: z
		.array(
			z.looseObject({
				provider: z.string(),
				model: z.string(),
				cost: fallbackCostSchema,
			}),
		)
		.optional(),
	supportsToolReferences: compatBooleanSchema,
});

export function modelCompatValidationError(value: unknown): string | null {
	const boundedIssue = boundedJsonObjectValidationError(value, MODEL_COMPAT_LIMITS);
	if (boundedIssue) return boundedIssue;
	const result = modelCompatKnownFieldsSchema.safeParse(value);
	if (result.success) return null;
	const issue = result.error.issues[0];
	if (!issue) return "value does not match Pi compatibility fields";
	const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
	return `${path}${issue.message}`;
}

export const modelSamplingParamsSchema: z.ZodType<BoundedJsonObject | null> = z
	.unknown()
	.transform((value, context) => {
		if (value === null) return null;
		const issue = boundedJsonObjectValidationError(value, MODEL_SAMPLING_PARAMS_LIMITS);
		if (issue) {
			context.addIssue({ code: "custom", message: `Invalid sampling parameters: ${issue}` });
			return z.NEVER;
		}
		return value as BoundedJsonObject;
	});

export const modelCompatSchema: z.ZodType<BoundedJsonObject | null> = z.unknown().transform((value, context) => {
	if (value === null) return null;
	const issue = modelCompatValidationError(value);
	if (issue) {
		context.addIssue({ code: "custom", message: `Invalid compatibility overrides: ${issue}` });
		return z.NEVER;
	}
	return value as BoundedJsonObject;
});

/** Pi uses negative rates for unknown pricing, including automatically routed models. */
const modelCostRatesSchema = {
	input: z.number(),
	output: z.number(),
	cacheRead: z.number(),
	cacheWrite: z.number(),
};
const thinkingMapValueSchema = z.string().nullable().optional();
/** Portable model metadata. Connections and authentication remain provider-owned. */
export const modelOptionsSchema = z
	.strictObject({
		api: z.string().trim().min(1).max(MODEL_PROVIDER_ID_MAX_CHARS).optional(),
		input: z.array(z.enum(["text", "image"])).optional(),
		promptCache: z
			.looseObject({ short: z.number().positive().optional(), long: z.number().positive().optional() })
			.optional(),
		thinkingLevelMap: z
			.looseObject({
				off: thinkingMapValueSchema,
				minimal: thinkingMapValueSchema,
				low: thinkingMapValueSchema,
				medium: thinkingMapValueSchema,
				high: thinkingMapValueSchema,
				xhigh: thinkingMapValueSchema,
				max: thinkingMapValueSchema,
			})
			.optional(),
		cost: z
			.looseObject({
				...modelCostRatesSchema,
				tiers: z.array(z.looseObject({ inputTokensAbove: z.number(), ...modelCostRatesSchema })).optional(),
			})
			.optional(),
	})
	.superRefine((value, context) => {
		const issue = boundedJsonObjectValidationError(value, MODEL_SAMPLING_PARAMS_LIMITS);
		if (issue) context.addIssue({ code: "custom", message: issue });
	});
export type ModelOptions = z.infer<typeof modelOptionsSchema>;

export interface ProviderModelDefinition {
	/** Explicit models.json value; null delegates the display name to Pi. */
	name: string | null;
	/** Explicit models.json value; null delegates the context window to Pi. */
	contextWindow: number | null;
	/** Explicit models.json value; null delegates the output limit to Pi. */
	maxTokens: number | null;
	/** False represents Pi's omitted/default non-reasoning state. */
	reasoning: boolean;
	samplingParams: BoundedJsonObject | null;
	/** Explicit compat on the models[] definition; top-level modelOverrides remain file-owned. */
	compat: BoundedJsonObject | null;
	/** Explicit portable metadata; absent keys continue to use Pi defaults. */
	options: ModelOptions;
}

export type ModelConfigurationRequest = z.infer<typeof requestSchemas.modelConfigurationRequestSchema>;

/** On-demand configuration inspection. Credential values and request headers are excluded. */
export interface ModelConfiguration {
	effective: BoundedJsonObject;
	configured: BoundedJsonObject | null;
	overrides: BoundedJsonObject | null;
	providerDefaults: BoundedJsonObject;
	template: ProviderModelDefinition;
	source: "builtin" | "custom" | "extension";
	hasModelHeaders: boolean;
}

export interface ProviderModelInfo {
	id: string;
	/** Effective runtime values used for display. */
	name: string;
	contextWindow: number;
	maxTokens: number;
	reasoning: boolean;
	/** Exact editable models[] fields, or null for a built-in/extension-only model. */
	definition: ProviderModelDefinition | null;
}

type ProviderAuthSource = "stored" | "runtime" | "environment" | "fallback" | "models_json_key" | "models_json_command";

export interface ProviderSummary {
	id: string;
	/** Explicit editable models.json name; null delegates the display name to Pi. */
	name: string | null;
	displayName: string;
	/** Whether auth.json-backed credential metadata was read successfully for this projection. */
	credentialStatus: "known" | "unknown";
	/** True when the provider has a complete stored, configured, or ambient auth source. A stored result is authoritative only while credentialStatus is known. */
	configured: boolean;
	/** Describes where the effective authentication comes from. */
	source: ProviderAuthSource | null;
	sourceLabel: string | null;
	/** Stored auth.json credential type. Ambient/configured auth leaves this null. */
	credentialType: "oauth" | "api_key" | null;
	authMethods: {
		apiKey: { name: string; interactive: boolean } | null;
		oauth: { name: string; loginLabel: string | null } | null;
	};
	/** True when the effective provider is registered by an extension in the active project. */
	projectExtension: boolean;
	/** Canonical project owning the effective extension provider; null for profile providers. */
	projectCwd: string | null;
	/** Shared auth.json access is fail-closed while provider ownership is ambiguous. */
	authConflict: boolean;
	custom: boolean;
	baseUrl: string | null;
	api: string | null;
	/** Explicit provider-level models.json defaults; inferred Pi defaults stay implicit. */
	compat: BoundedJsonObject | null;
	models: ProviderModelInfo[];
}

// This is Pi's public models.json protocol set, validated again at the Core boundary.
/** Closed set of custom-provider API protocols, matching Pi's public models.json protocol set; re-validated at the core boundary, and ad-hoc protocol names are rejected. */
export const CUSTOM_PROVIDER_APIS = [
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
	"google-generative-ai",
] as const;
export type CustomProviderApi = (typeof CUSTOM_PROVIDER_APIS)[number];

export type AddCustomProviderRequest = z.infer<typeof requestSchemas.addCustomProviderRequestSchema>;

export type ProbeCustomProviderRequest = z.infer<typeof requestSchemas.probeCustomProviderRequestSchema>;

export type EndpointProbeResult =
	| { ok: true; modelCount: number | null }
	| { ok: false; reason: "unreachable" | "timeout" | "auth" | "http"; status?: number };

export type AddCustomModelRequest = z.infer<typeof requestSchemas.addCustomModelRequestSchema>;

export type RemoveCustomModelRequest = z.infer<typeof requestSchemas.removeCustomModelRequestSchema>;

export type UpdateCustomProviderRequest = z.infer<typeof requestSchemas.updateCustomProviderRequestSchema>;

export type UpdateCustomModelRequest = z.infer<typeof requestSchemas.updateCustomModelRequestSchema>;

export interface ProviderCatalog {
	providers: ProviderSummary[];
	configError: string | null;
}

/** Read-only effective model catalog for one open project. Unlike ProviderCatalog,
 * this includes project/package extension providers from that project's Pi runtime. */
export type ProjectModelCatalogRequest = z.infer<typeof requestSchemas.projectModelCatalogRequestSchema>;

export interface ProjectModelCatalog {
	cwd: string;
	models: ModelInfo[];
	/** Effective extension providers for this project, including unconfigured providers. */
	extensionProviders: ProviderSummary[];
	configError: string | null;
}

export type ProviderAuthTarget = z.infer<typeof requestSchemas.providerAuthTargetSchema>;

export type SetProviderApiKeyRequest = z.infer<typeof requestSchemas.setProviderApiKeyRequestSchema>;

export type LoginStartRequest = z.infer<typeof requestSchemas.loginStartRequestSchema>;

export type LoginRespondRequest = z.infer<typeof requestSchemas.loginRespondRequestSchema>;

export type LoginCancelRequest = z.infer<typeof requestSchemas.loginCancelRequestSchema>;

export type CredentialSynchronizationState = "ready" | "recovered" | "pending";

export type ModelLoginEvent =
	| { type: "auth-url"; url: string; instructions: string | null }
	| { type: "device-code"; userCode: string; verificationUri: string }
	| { type: "info"; message: string; links: { url: string; label: string | null }[] }
	| {
			type: "prompt";
			requestId: string;
			message: string;
			placeholder: string | null;
			secret: boolean;
	  }
	| { type: "manual-code"; requestId: string; message: string; placeholder: string | null }
	| {
			type: "select";
			requestId: string;
			message: string;
			options: { id: string; label: string; description: string | null }[];
	  }
	| { type: "request-cancelled"; requestId: string }
	| { type: "progress"; message: string }
	| {
			type: "done";
			ok: boolean;
			error: string | null;
			credentialSynchronization: CredentialSynchronizationState | null;
	  };

export interface ModelLoginEventEnvelope {
	flowId: string;
	event: ModelLoginEvent;
}

export interface ModelCatalogRefreshResult {
	aborted: boolean;
	timedOut: boolean;
	errors: { provider: string; message: string }[];
	/** Custom definitions replaced by matching entries from the official catalog. */
	adoptedModels: { provider: string; modelId: string }[];
	/** Snapshot before the latest adoption; null when no definitions changed. */
	backupPath: string | null;
}

/** Preserve independent catalog failures without repeating the same cause. */
export function combineProviderCatalogErrors(...errors: Array<string | null | undefined>): string | null {
	const distinct = [...new Set(errors.filter((error): error is string => error !== null && error !== undefined))];
	return distinct.length > 0 ? distinct.join("\n\n") : null;
}
