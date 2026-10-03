import { z } from "zod";
import { boundedJsonObjectValidationError, type BoundedJsonObject } from "./bounded-json";
import { portableAbsolutePathSchema } from "./path-validation";
import { THINKING_LEVELS, type PiResourceReloadSummary } from "./session";

/** Configuration shares the canonical file's 4 MiB budget, including extension-owned fields. */
const limits = {
	maxDepth: 32,
	maxNodes: 100_000,
	maxObjectKeys: 10_000,
	maxArrayItems: 10_000,
	maxKeyChars: 1024,
	maxStringChars: 4 * 1024 * 1024,
	maxBytes: 4 * 1024 * 1024,
};
export const piConfigurationObjectSchema = z.custom<BoundedJsonObject>(
	(value) => boundedJsonObjectValidationError(value, limits) === null,
	"Pi configuration must be a bounded JSON object",
);
const count = z.number().int().nonnegative();
const thinking = z.enum(THINKING_LEVELS);
const paths = z.array(z.string());
const budget = z.looseObject({ reserveTokens: count.optional(), keepRecentTokens: count.optional() });

/** Known operational fields retain Pi's value domain; extension fields remain intact. */
export const piConfigurationSettingsSchema = z
	.looseObject({
		defaultProvider: z.string().optional(),
		defaultModel: z.string().optional(),
		defaultThinkingLevel: thinking.optional(),
		modelThinkingLevels: z.record(z.string(), thinking).optional(),
		thinkingBudgets: z.record(z.string(), count).optional(),
		transport: z.enum(["auto", "sse", "websocket", "websocket-cached"]).optional(),
		steeringMode: z.enum(["all", "one-at-a-time"]).optional(),
		followUpMode: z.enum(["all", "one-at-a-time"]).optional(),
		compaction: budget
			.extend({ enabled: z.boolean().optional(), modelOverrides: z.record(z.string(), budget).optional() })
			.optional(),
		branchSummary: z.looseObject({ reserveTokens: count.optional(), skipPrompt: z.boolean().optional() }).optional(),
		retry: z
			.looseObject({
				enabled: z.boolean().optional(),
				maxRetries: count.optional(),
				baseDelayMs: count.optional(),
				maxAgentDelayMs: count.optional(),
				provider: z
					.looseObject({ timeoutMs: count.optional(), maxRetries: count.optional(), maxRetryDelayMs: count.optional() })
					.optional(),
			})
			.optional(),
		httpIdleTimeoutMs: z
			.union([
				z.number().nonnegative(),
				z
					.string()
					.refine(
						(value) =>
							value.trim() === "" ||
							value.trim().toLowerCase() === "disabled" ||
							(Number.isFinite(Number(value)) && Number(value) >= 0),
					),
			])
			.optional(),
		websocketConnectTimeoutMs: count.optional(),
		cacheWarming: z.enum(["off", "streaming", "idle"]).optional(),
		defaultProjectTrust: z.enum(["ask", "always", "never"]).optional(),
		shellPath: z.string().optional(),
		shellCommandPrefix: z
			.string()
			.refine((value) => !value.includes("\0"))
			.optional(),
		npmCommand: z.array(z.string()).min(1).optional(),
		sessionDir: z
			.string()
			.refine((value) => !value.includes("\0"))
			.optional(),
		httpProxy: z.string().optional(),
		enabledModels: paths.optional(),
		defaultTools: paths.optional(),
		extensions: paths.optional(),
		skills: paths.optional(),
		prompts: paths.optional(),
		themes: paths.optional(),
		enableSkillCommands: z.boolean().optional(),
		enableInstallTelemetry: z.boolean().optional(),
		enableAnalytics: z.boolean().optional(),
		images: z.looseObject({ autoResize: z.boolean().optional(), blockImages: z.boolean().optional() }).optional(),
		codemode: z.looseObject({ mode: z.enum(["on", "only"]).optional(), inlineBudget: count.optional() }).optional(),
	})
	.pipe(piConfigurationObjectSchema);
const cwdSchema = portableAbsolutePathSchema("Project path");
export const piConfigurationReadSchema = z.strictObject({ cwd: cwdSchema.nullable() });
export const piConfigurationWriteSchema = piConfigurationReadSchema.extend({
	revision: z.string().length(64),
	settings: piConfigurationSettingsSchema,
});
export const piConfigurationSnapshotSchema = z.strictObject({
	cwd: cwdSchema.nullable(),
	path: z.string(),
	revision: z.string().length(64),
	trusted: z.boolean(),
	configured: piConfigurationObjectSchema,
	inherited: piConfigurationObjectSchema,
	resolved: piConfigurationObjectSchema,
	diagnostics: z.array(z.string()),
});
export type PiConfigurationSnapshot = z.infer<typeof piConfigurationSnapshotSchema>;
export type PiConfigurationWrite = z.infer<typeof piConfigurationWriteSchema>;
export interface PiConfigurationWriteResult {
	configuration: PiConfigurationSnapshot;
	reload: PiResourceReloadSummary | null;
}

/** Pi reads these fields only from its agent-directory settings. */
export const PI_GLOBAL_CONFIGURATION_KEYS = ["defaultProjectTrust", "cacheWarming", "httpProxy", "deviceId"] as const;
/** These settings describe terminal presentation rather than the shared graphical workbench. */
export const PI_TERMINAL_CONFIGURATION_KEYS = [
	"theme",
	"terminal",
	"quietStartup",
	"collapseChangelog",
	"externalEditor",
	"doubleEscapeAction",
	"editorPaddingX",
	"outputPad",
	"autocompleteMaxVisible",
	"showHardwareCursor",
	"tuiMode",
	"fullscreenExitOutput",
	"fullscreenScrollbar",
	"fullscreenCopyOnSelect",
	"fullscreenWheelScrollLines",
] as const;
