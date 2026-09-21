import {
	CUSTOM_PROVIDER_APIS,
	MODEL_DISPLAY_NAME_MAX_CHARS,
	MODEL_ID_MAX_CHARS,
	MODEL_LOGIN_REQUEST_ID_MAX_CHARS,
	MODEL_LOGIN_RESPONSE_MAX_CHARS,
	MODEL_PROVIDER_ID_MAX_CHARS,
	MODEL_SECRET_MAX_CHARS,
	modelSamplingParamsSchema,
	modelCompatSchema,
	modelOptionsSchema,
} from "@ling/contracts/model";
import {
	boundedString,
	httpUrlSchema,
	nonEmptyBoundedString,
	safeIdSchema,
	strictObject,
} from "@ling/contracts/schema-primitives";
import { portableAbsolutePathSchema } from "./path-validation";
import { z } from "zod";

export const providerIdSchema = safeIdSchema(MODEL_PROVIDER_ID_MAX_CHARS, "Provider id");

const projectPathSchema = portableAbsolutePathSchema("Project path");

export const projectModelCatalogRequestSchema = strictObject({
	cwd: projectPathSchema,
});

const nullableProjectPathSchema = projectPathSchema.nullable();

export const providerAuthTargetSchema = strictObject({
	provider: providerIdSchema,
	cwd: nullableProjectPathSchema,
});

const customProviderIdSchema = providerIdSchema.regex(
	/^[a-z0-9][a-z0-9._-]*$/,
	'Provider id must use lowercase letters, digits, ".", "_" or "-"',
);

const modelIdSchema = safeIdSchema(MODEL_ID_MAX_CHARS, "Model id");

export const modelConfigurationRequestSchema = strictObject({
	provider: providerIdSchema,
	modelId: modelIdSchema,
	cwd: nullableProjectPathSchema,
});

const nullableDisplayNameSchema = boundedString(MODEL_DISPLAY_NAME_MAX_CHARS, "Display name").nullable();

const baseUrlSchema = httpUrlSchema("Base URL");

const apiKeySchema = nonEmptyBoundedString(MODEL_SECRET_MAX_CHARS, "API key");
const nullableApiKeySchema = boundedString(MODEL_SECRET_MAX_CHARS, "API key")
	.refine((value) => value.trim().length > 0, "API key must not be empty")
	.nullable();
const nullablePositiveSafeIntegerSchema = z.number().int().positive().nullable();

export const addCustomProviderRequestSchema = strictObject({
	id: customProviderIdSchema,
	name: nullableDisplayNameSchema,
	baseUrl: baseUrlSchema,
	api: z.enum(CUSTOM_PROVIDER_APIS),
	apiKey: nullableApiKeySchema,
	compat: modelCompatSchema,
});

export const probeCustomProviderRequestSchema = strictObject({
	baseUrl: baseUrlSchema,
	apiKey: nullableApiKeySchema,
});

export const updateCustomProviderRequestSchema = strictObject({
	provider: providerIdSchema,
	name: nullableDisplayNameSchema,
	baseUrl: baseUrlSchema,
	api: z.enum(CUSTOM_PROVIDER_APIS).nullable(),
	compat: modelCompatSchema,
});

export const addCustomModelRequestSchema = strictObject({
	provider: providerIdSchema,
	id: modelIdSchema,
	name: nullableDisplayNameSchema,
	contextWindow: nullablePositiveSafeIntegerSchema,
	maxTokens: nullablePositiveSafeIntegerSchema,
	reasoning: z.boolean(),
	samplingParams: modelSamplingParamsSchema,
	compat: modelCompatSchema,
	options: modelOptionsSchema.optional(),
});

export const updateCustomModelRequestSchema = strictObject({
	provider: providerIdSchema,
	modelId: modelIdSchema,
	name: nullableDisplayNameSchema,
	contextWindow: nullablePositiveSafeIntegerSchema,
	maxTokens: nullablePositiveSafeIntegerSchema,
	reasoning: z.boolean(),
	samplingParams: modelSamplingParamsSchema,
	compat: modelCompatSchema,
	options: modelOptionsSchema.optional(),
});

export const removeCustomModelRequestSchema = strictObject({
	provider: providerIdSchema,
	modelId: modelIdSchema,
});

export const setProviderApiKeyRequestSchema = strictObject({
	provider: providerIdSchema,
	key: apiKeySchema,
});

export const loginStartRequestSchema = strictObject({
	flowId: z.uuid(),
	provider: providerIdSchema,
	method: z.enum(["api_key", "oauth"]),
	cwd: nullableProjectPathSchema,
});

export const loginRespondRequestSchema = strictObject({
	flowId: z.uuid(),
	requestId: nonEmptyBoundedString(MODEL_LOGIN_REQUEST_ID_MAX_CHARS, "Login request id"),
	value: boundedString(MODEL_LOGIN_RESPONSE_MAX_CHARS, "Login response").nullable(),
});

export const loginCancelRequestSchema = strictObject({
	flowId: z.uuid(),
});
