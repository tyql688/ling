import { MODEL_ID_MAX_CHARS, MODEL_PROVIDER_ID_MAX_CHARS } from "@ling/contracts/model";
import {
	HTTP_IDLE_TIMEOUT_CHOICES_MS,
	PI_BUILT_IN_TOOL_NAMES,
	PI_COMPACTION_TOKEN_MAX,
	PI_COMPACTION_TOKEN_MIN,
	PI_CACHE_WARMING_MODES,
	PI_RETRY_MAX_DELAY_MS_MAX,
	PI_RETRY_BASE_DELAY_MS_MAX,
	PI_RETRY_BASE_DELAY_MS_MIN,
	PI_RETRY_MAX_RETRIES_MAX,
	PI_RETRY_MAX_RETRIES_MIN,
	PI_SETTINGS_NPM_COMMAND_MAX_CHARS,
	PI_SETTINGS_SHELL_PATH_MAX_CHARS,
	PI_SETTINGS_SHELL_PREFIX_MAX_CHARS,
} from "@ling/contracts/pi-settings";
import { THINKING_LEVELS } from "@ling/contracts/session";
import { parseNpmCommand } from "@ling/contracts/npm-command";
import { toError } from "@ling/contracts/ling-error";
import { hardenObjectSchema, safeIdSchema } from "@ling/contracts/schema-primitives";
import { hasControlCharacter } from "@ling/contracts/text-validation";
import { z } from "zod";

import { isPortableAbsolutePath } from "./path-validation";

/** The native boundary supplies OS-specific absolute and home-directory spelling. */
export function createPiSettingsUpdateSchema(
	isShellPath = (value: string) => isPortableAbsolutePath(value) || /^~[/\\]/.test(value),
) {
	const providerSchema = safeIdSchema(MODEL_PROVIDER_ID_MAX_CHARS, "Provider id");
	const modelIdSchema = safeIdSchema(MODEL_ID_MAX_CHARS, "Model id");
	const shellPathSchema = z
		.string()
		.min(1)
		.max(PI_SETTINGS_SHELL_PATH_MAX_CHARS)
		.refine((value) => !value.includes("\0"), "Shell path is invalid")
		.refine((value) => isShellPath(value), "Shell path must be absolute or start with ~/")
		.nullable();
	const npmCommandSchema = z
		.string()
		.max(PI_SETTINGS_NPM_COMMAND_MAX_CHARS)
		.refine((value) => !hasControlCharacter(value), "npm command must not contain control characters")
		.superRefine((value, context) => {
			try {
				parseNpmCommand(value);
			} catch (error) {
				context.addIssue({ code: "custom", message: toError(error).message });
			}
		})
		.nullable();

	return hardenObjectSchema(
		z.discriminatedUnion("type", [
			z.strictObject({ type: z.literal("defaultModel"), provider: providerSchema, modelId: modelIdSchema }),
			z.strictObject({ type: z.literal("thinkingLevel"), level: z.enum(THINKING_LEVELS) }),
			z.strictObject({ type: z.literal("compaction"), enabled: z.boolean() }),
			z.strictObject({ type: z.literal("cacheWarming"), mode: z.enum(PI_CACHE_WARMING_MODES) }),
			z.strictObject({
				type: z.literal("compactionModel"),
				provider: providerSchema,
				modelId: modelIdSchema,
				override: z
					.strictObject({
						reserveTokens: z.number().int().min(PI_COMPACTION_TOKEN_MIN).max(PI_COMPACTION_TOKEN_MAX).optional(),
						keepRecentTokens: z.number().int().min(PI_COMPACTION_TOKEN_MIN).max(PI_COMPACTION_TOKEN_MAX).optional(),
					})
					.nullable(),
			}),
			z.strictObject({
				type: z.literal("compactionTokens"),
				field: z.enum(["reserveTokens", "keepRecentTokens"]),
				tokens: z.number().int().min(PI_COMPACTION_TOKEN_MIN).max(PI_COMPACTION_TOKEN_MAX),
			}),
			z.strictObject({ type: z.literal("retry"), enabled: z.boolean() }),
			z
				.strictObject({
					type: z.literal("retryTuning"),
					field: z.enum(["maxRetries", "baseDelayMs", "maxAgentDelayMs"]),
					value: z.number().int().nonnegative().max(PI_RETRY_MAX_DELAY_MS_MAX),
				})
				.superRefine((update, context) => {
					const [min, max] =
						update.field === "maxRetries"
							? [PI_RETRY_MAX_RETRIES_MIN, PI_RETRY_MAX_RETRIES_MAX]
							: update.field === "baseDelayMs"
								? [PI_RETRY_BASE_DELAY_MS_MIN, PI_RETRY_BASE_DELAY_MS_MAX]
								: [0, PI_RETRY_MAX_DELAY_MS_MAX];
					if (update.value < min || update.value > max) {
						context.addIssue({ code: "custom", path: ["value"], message: `Value must be between ${min} and ${max}` });
					}
				}),
			z.strictObject({ type: z.literal("blockImages"), blocked: z.boolean() }),
			z.strictObject({ type: z.literal("imageAutoResize"), enabled: z.boolean() }),
			z.strictObject({
				type: z.literal("shellCommandPrefix"),
				prefix: z
					.string()
					.min(1)
					.max(PI_SETTINGS_SHELL_PREFIX_MAX_CHARS)
					.refine((value) => !value.includes("\0"), "Shell command prefix must not contain null bytes")
					.nullable(),
			}),
			z.strictObject({ type: z.literal("defaultProjectTrust"), trust: z.enum(["ask", "always", "never"]) }),
			z.strictObject({ type: z.literal("steeringMode"), mode: z.enum(["all", "one-at-a-time"]) }),
			z.strictObject({ type: z.literal("followUpMode"), mode: z.enum(["all", "one-at-a-time"]) }),
			z.strictObject({ type: z.literal("shellPath"), path: shellPathSchema }),
			z.strictObject({ type: z.literal("npmCommand"), command: npmCommandSchema }),
			z.strictObject({ type: z.literal("installTelemetry"), enabled: z.boolean() }),
			z.strictObject({ type: z.literal("analytics"), enabled: z.boolean() }),
			z.strictObject({
				type: z.literal("httpIdleTimeoutMs"),
				timeoutMs: z.union([
					z.literal(HTTP_IDLE_TIMEOUT_CHOICES_MS[0]),
					z.literal(HTTP_IDLE_TIMEOUT_CHOICES_MS[1]),
					z.literal(HTTP_IDLE_TIMEOUT_CHOICES_MS[2]),
					z.literal(HTTP_IDLE_TIMEOUT_CHOICES_MS[3]),
					z.literal(HTTP_IDLE_TIMEOUT_CHOICES_MS[4]),
				]),
			}),
			z.strictObject({ type: z.literal("enableSkillCommands"), enabled: z.boolean() }),
			z.strictObject({
				type: z.literal("defaultTools"),
				tools: z
					.array(z.enum(PI_BUILT_IN_TOOL_NAMES))
					.max(PI_BUILT_IN_TOOL_NAMES.length)
					.refine((tools) => new Set(tools).size === tools.length, "Duplicate Pi built-in tool"),
			}),
		]),
	);
}
export const piSettingsUpdateSchema = createPiSettingsUpdateSchema();
