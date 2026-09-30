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
/** Smallest editable compaction budget. Pi sizes the summary request at 0.8×reserveTokens,
 * so tiny values produce max_tokens 0 and every compaction fails with a provider 400. */
export const PI_COMPACTION_TOKEN_MIN = 1_024;
/** Largest editable compaction budget. reserveTokens beyond the model's context window makes
 * shouldCompact true on every turn (constant summarization, history loss); 512k stays useful
 * even for 1M-window models. */
export const PI_COMPACTION_TOKEN_MAX = 512_000;

export type MessageDeliveryMode = "all" | "one-at-a-time";

/** Mirrors Pi's DefaultProjectTrust: what to do when an untrusted project is opened. */
export type DefaultProjectTrust = "ask" | "always" | "never";

/** Retry attempt bounds; Pi defaults to 3, more than 10 only hides a broken provider. */
export const PI_RETRY_MAX_RETRIES_MIN = 1;
export const PI_RETRY_MAX_RETRIES_MAX = 10;
/** Base backoff bounds (ms); Pi defaults to 2000, growing exponentially per attempt. */
export const PI_RETRY_BASE_DELAY_MS_MIN = 100;
export const PI_RETRY_BASE_DELAY_MS_MAX = 60_000;
/** Limit one agent retry wait to five minutes; zero disables the delay. */
export const PI_RETRY_MAX_DELAY_MS_MAX = 300_000;

export const PI_CACHE_WARMING_MODES = ["off", "streaming", "idle"] as const;
export const PI_DEFAULT_TOOL_NAMES = ["read", "bash", "edit", "write"] as const;
// Bound the generated tool-description budget exposed by the settings editor.
export const PI_CODEMODE_INLINE_BUDGET_MAX = 128_000;
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
/** Cap for the bash command prefix; it is prepended to every bash tool invocation. */
export const PI_SETTINGS_SHELL_PREFIX_MAX_CHARS = 1_024;

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

/** Mirrors Pi's HTTP idle timeout choices in milliseconds; zero disables the timeout. */
export const HTTP_IDLE_TIMEOUT_CHOICES_MS = [30_000, 60_000, 120_000, 300_000, 0] as const;
