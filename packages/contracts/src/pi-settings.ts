import { z } from "zod";
import type * as requestSchemas from "./pi-settings-requests";
import { ABSOLUTE_PATH_MAX_CHARS } from "./path-bounds";
import type { ThinkingLevel } from "./session";
import { safeIdSchema } from "./schema-primitives";

// Shell paths use Ling's absolute-path boundary. An npm command is additionally capped
// at 16 KiB after parsing, with at most 64 wrapper arguments of at most 4 KiB each.
/** Character cap for shellPath: shares {@link ABSOLUTE_PATH_MAX_CHARS}, preventing unbounded shell paths from being written into Pi settings. */
export const PI_SETTINGS_SHELL_PATH_MAX_CHARS = ABSOLUTE_PATH_MAX_CHARS;
/** 16 KiB cap on the parsed npm command string: keeps wrapper commands bounded so oversized commands never reach settings. */
export const PI_SETTINGS_NPM_COMMAND_MAX_CHARS = 16_384;
/** Cap of 64 npm command arguments: bounds argv fan-out, paired with the parsed total length. */
export const PI_SETTINGS_NPM_COMMAND_MAX_ARGS = 64;
/** 4 KiB cap per npm argument: each arg is bounded, completing the count/total-length/arg-length triple cap. */
export const PI_SETTINGS_NPM_ARGUMENT_MAX_CHARS = 4_096;
/** Pi accepts non-negative safe integer compaction budgets. */
export const PI_COMPACTION_TOKEN_MIN = 0;
export const PI_COMPACTION_TOKEN_MAX = Number.MAX_SAFE_INTEGER;

export type MessageDeliveryMode = "all" | "one-at-a-time";

/** Trust policy applied when opening an untrusted project. */
export type DefaultProjectTrust = "ask" | "always" | "never";

/** Retry values retain Pi's non-negative integer domain. */
export const PI_RETRY_MAX_RETRIES_MIN = 0;
export const PI_RETRY_MAX_RETRIES_MAX = Number.MAX_SAFE_INTEGER;
export const PI_RETRY_BASE_DELAY_MS_MIN = 0;
export const PI_RETRY_BASE_DELAY_MS_MAX = Number.MAX_SAFE_INTEGER;
export const PI_RETRY_MAX_DELAY_MS_MAX = Number.MAX_SAFE_INTEGER;

export const PI_CACHE_WARMING_MODES = ["off", "streaming", "idle"] as const;
export const PI_DEFAULT_TOOL_NAMES = ["read", "bash", "edit", "write"] as const;
// Bound the generated tool-description budget exposed by the settings editor.
export const PI_CODEMODE_INLINE_BUDGET_MAX = Number.MAX_SAFE_INTEGER;
export const piCodemodeSettingsSchema = z.strictObject({
	mode: z.enum(["on", "only"]),
	inlineBudget: z.number().int().min(0).max(PI_CODEMODE_INLINE_BUDGET_MAX),
});
export const piDefaultToolsSchema = z
	.array(safeIdSchema(256, "Tool name").refine((name) => !/^[+-]/.test(name), "Use resolved tool names"))
	.max(256)
	.refine((tools) => new Set(tools).size === tools.length, "Duplicate Pi tool");
type CacheWarmingMode = (typeof PI_CACHE_WARMING_MODES)[number];
export const piCompactionModelOverridesSchema = z.record(
	z.string(),
	z.object({
		reserveTokens: z.number().int().nonnegative().optional(),
		keepRecentTokens: z.number().int().nonnegative().optional(),
	}),
);
/** Prefix reads share the canonical settings file byte budget. */
export const PI_SETTINGS_SHELL_PREFIX_MAX_CHARS = 4 * 1024 * 1024;

export interface PiSettingsSnapshot {
	defaultProvider: string | null;
	defaultModel: string | null;
	defaultThinkingLevel: ThinkingLevel | null;
	compactionEnabled: boolean;
	compactionReserveTokens: number;
	compactionKeepRecentTokens: number;
	compactionModelOverrides: z.infer<typeof piCompactionModelOverridesSchema>;
	cacheWarming: CacheWarmingMode;
	retryEnabled: boolean;
	retryMaxRetries: number;
	retryBaseDelayMs: number;
	retryMaxAgentDelayMs: number;
	/** Prevents image content, including Ling attachments, from reaching the model. */
	blockImages: boolean;
	/** Downscale images before the read tool sends them to the model (Pi's images.autoResize). */
	imageAutoResize: boolean;
	/** Prepended to every bash tool command (e.g. "shopt -s expand_aliases"); null = none. */
	shellCommandPrefix: string | null;
	/** Trust policy applied when an untrusted project is opened. */
	defaultProjectTrust: DefaultProjectTrust;
	steeringMode: MessageDeliveryMode;
	followUpMode: MessageDeliveryMode;
	/** Null uses the system shell selected by Pi. */
	shellPath: string | null;
	/** Null lets Pi use npm from PATH. */
	npmCommand: string | null;
	installTelemetry: boolean;
	analytics: boolean;
	httpIdleTimeoutMs: number;
	/** Expose loaded skills as /skill:name commands (Pi's enableSkillCommands). */
	enableSkillCommands: boolean;
	/** Resolved initial tool selection, including Pi's defaults when no selection is saved. */
	defaultTools: string[];
	defaultToolsConfigured: boolean;
	codemode: z.infer<typeof piCodemodeSettingsSchema>;
}

export type PiSettingsRecoveryStatus =
	| { status: "ready" }
	| { status: "recoveryRequired"; code: "INVALID_HTTP_IDLE_TIMEOUT"; field: "httpIdleTimeoutMs" }
	| { status: "unavailable"; code: "PI_SETTINGS_READ_FAILED" };

export type PiSettingsUpdate = z.infer<typeof requestSchemas.piSettingsUpdateSchema>;

/**
 * Pi's built-in tool names, in the order the settings UI lists them. Pi enables read, bash,
 * edit, and write when `defaultTools` is unset. MCP activates codemode/tool_search as required
 * by server exposure. Other tools are opt-in. `powershell`
 * runs through pwsh/Windows PowerShell, so the UI offers it on Windows only; the schemas keep
 * accepting it everywhere because settings.json can travel between machines.
 */
export const PI_BUILT_IN_TOOL_NAMES = [
	"read",
	"bash",
	"powershell",
	"edit",
	"write",
	"find",
	"grep",
	"ls",
	"codemode",
	"tool_search",
] as const;

/** Pi's HTTP idle timeout choices in milliseconds. Zero disables the timeout. */
export const HTTP_IDLE_TIMEOUT_CHOICES_MS = [30_000, 60_000, 120_000, 300_000, 0] as const;
