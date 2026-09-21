import {
	type PiSettingsRecoveryStatus,
	type PiSettingsSnapshot,
	type PiSettingsUpdate,
	PI_COMPACTION_TOKEN_MAX,
	PI_COMPACTION_TOKEN_MIN,
	PI_RETRY_MAX_DELAY_MS_MAX,
	piCompactionModelOverridesSchema,
	PI_RETRY_BASE_DELAY_MS_MAX,
	PI_RETRY_BASE_DELAY_MS_MIN,
	PI_RETRY_MAX_RETRIES_MAX,
	PI_RETRY_MAX_RETRIES_MIN,
	PI_SETTINGS_NPM_COMMAND_MAX_CHARS,
	PI_SETTINGS_SHELL_PREFIX_MAX_CHARS,
} from "@ling/contracts/pi-settings";
import { assertNpmCommandParts, parseNpmCommand } from "@ling/contracts/npm-command";
import { homedir } from "node:os";
import { createLogger } from "../../logger";
import { createInMemorySettingsManager, createSettingsManager } from "../sdk-factories";
import type { PiSettingsManager } from "../types";
import { createPiGlobalSettingsStore } from "./global-settings-store";
import { createPiHttpProxy } from "./http-proxy";
import { createPiSettingsMutations } from "./settings-mutation";

const log = createLogger("pi-settings");
function isValidPiHttpIdleTimeout(value: unknown): boolean {
	if (value === undefined) return true;
	if (typeof value === "number") return Number.isFinite(value) && value >= 0;
	if (typeof value !== "string") return false;
	const trimmed = value.trim();
	if (trimmed.length === 0 || trimmed.toLowerCase() === "disabled") return true;
	const parsed = Number(trimmed);
	return Number.isFinite(parsed) && parsed >= 0;
}

/** settings.json is shared with the pi CLI and hand edits; Pi's getters return whatever is
 * stored. Normalize on read so one bad value cannot brick the whole settings view — the
 * strict range check applies only when Ling writes. */
function clampSetting(value: number, min: number, max: number): number {
	const rounded = Number.isFinite(value) ? Math.round(value) : min;
	return Math.min(max, Math.max(min, rounded));
}

function normalizeCompactionTokens(value: number): number {
	return clampSetting(value, PI_COMPACTION_TOKEN_MIN, PI_COMPACTION_TOKEN_MAX);
}

function assertNoSettingsErrors(settings: PiSettingsManager, action: string): void {
	const errors = settings.drainErrors();
	if (errors.length === 0) return;
	const detail = errors.map(({ scope, error }) => `${scope}: ${error.message}`).join("; ");
	const first = errors[0];
	if (!first) throw new Error(`Failed to ${action} Pi settings`);
	throw new Error(`Failed to ${action} Pi settings (${detail})`, { cause: first.error });
}

function formatCommandPart(part: string): string {
	// A trailing backslash would escape the separator before the next argv entry.
	if (part.length > 0 && !part.endsWith("\\") && !/[\s'"]/.test(part)) return part;
	// Single-quoted segments keep Windows backslashes literal. A literal apostrophe
	// is represented by closing the segment, adding a double-quoted apostrophe, and
	// reopening it: 'one'"'"'two'. This is unambiguous and round-trips every string.
	return `'${part.replaceAll("'", `'"'"'`)}'`;
}

function formatNpmCommand(command: string[] | undefined): string | null {
	if (!command || command.length === 0) return null;
	assertNpmCommandParts(command);
	const formatted = command.map(formatCommandPart).join(" ");
	if (formatted.length > PI_SETTINGS_NPM_COMMAND_MAX_CHARS) throw new Error("Invalid npm command");
	return formatted;
}

/** getShellCommandPrefix returns the raw stored value; a hand-edited non-string must not
 * brick the settings view. Over-long prefixes are truncated rather than dropped. */
function normalizeShellCommandPrefix(value: unknown): string | null {
	if (typeof value !== "string" || value.length === 0) return null;
	return value.slice(0, PI_SETTINGS_SHELL_PREFIX_MAX_CHARS);
}

export function createPiSettings(agentDir: string) {
	const globalSettingsStore = createPiGlobalSettingsStore(agentDir);
	const mutations = createPiSettingsMutations();
	const { enqueueGlobalSettingsMutation } = mutations;
	const network = createPiHttpProxy({ agentDir, globalSettingsStore, mutations });
	const { reconfigureHttpDispatcher } = network;
	let disposal: Promise<void> | null = null;
	function dispose(): Promise<void> {
		disposal ??= mutations.shutdownGlobalSettingsMutations().then(() => network.dispose());
		return disposal;
	}

	async function getPiSettingsRecoveryStatus(): Promise<PiSettingsRecoveryStatus> {
		try {
			const settings = await globalSettingsStore.read();
			return isValidPiHttpIdleTimeout(settings.httpIdleTimeoutMs)
				? { status: "ready" }
				: { status: "recoveryRequired", code: "INVALID_HTTP_IDLE_TIMEOUT", field: "httpIdleTimeoutMs" };
		} catch {
			return { status: "unavailable", code: "PI_SETTINGS_READ_FAILED" };
		}
	}

	async function repairPiHttpIdleTimeout(): Promise<void> {
		await enqueueGlobalSettingsMutation(async () => {
			await globalSettingsStore.update((settings) => {
				if (isValidPiHttpIdleTimeout(settings.httpIdleTimeoutMs)) {
					throw new Error("Pi HTTP idle timeout does not require repair");
				}
				delete settings.httpIdleTimeoutMs;
			});
			reconfigureHttpDispatcher();
		});
	}

	/**
	 * The GUI face of pi's /settings. Reads and SDK-supported writes use Pi's
	 * SettingsManager against the global settings.json shared with the CLI. A fresh manager
	 * per call keeps reads stale-proof against external edits.
	 */
	function manager(): PiSettingsManager {
		// This surface edits Pi's global settings. Do not accidentally merge a
		// ~/.pi/settings.json project override just because Ling uses homedir as cwd.
		return createSettingsManager(homedir(), agentDir, { projectTrusted: false });
	}

	function getPiNpmCommandExecutable(): string {
		const settings = manager();
		assertNoSettingsErrors(settings, "load");
		const command = settings.getNpmCommand();
		if (!command || command.length === 0) return "npm";
		assertNpmCommandParts(command);
		return command[0];
	}

	/** The configured built-in tool floor, or null when Pi should apply its own default set. */
	function getPiDefaultTools(): string[] | null {
		const configured = manager().getDefaultTools();
		return configured && configured.length > 0 ? [...configured] : null;
	}

	async function getPiSettings(): Promise<PiSettingsSnapshot> {
		return enqueueGlobalSettingsMutation(async () => {
			// Async reads must not contend with Pi's synchronous lock retry on this same thread.
			const settings = createInMemorySettingsManager(await globalSettingsStore.read());
			assertNoSettingsErrors(settings, "load");
			const retrySettings = settings.getRetrySettings();
			const compactionModelOverrides = piCompactionModelOverridesSchema.parse(
				settings.getGlobalSettings().compaction?.modelOverrides ?? {},
			);
			return {
				defaultProvider: settings.getDefaultProvider() ?? null,
				defaultModel: settings.getDefaultModel() ?? null,
				defaultThinkingLevel: settings.getDefaultThinkingLevel() ?? null,
				compactionEnabled: settings.getCompactionEnabled(),
				compactionReserveTokens: normalizeCompactionTokens(settings.getCompactionReserveTokens()),
				compactionKeepRecentTokens: normalizeCompactionTokens(settings.getCompactionKeepRecentTokens()),
				compactionModelOverrides,
				cacheWarming: settings.getCacheWarmingMode(),
				retryEnabled: settings.getRetryEnabled(),
				retryMaxRetries: clampSetting(retrySettings.maxRetries, PI_RETRY_MAX_RETRIES_MIN, PI_RETRY_MAX_RETRIES_MAX),
				retryBaseDelayMs: clampSetting(
					retrySettings.baseDelayMs,
					PI_RETRY_BASE_DELAY_MS_MIN,
					PI_RETRY_BASE_DELAY_MS_MAX,
				),
				retryMaxAgentDelayMs: clampSetting(retrySettings.maxAgentDelayMs, 0, PI_RETRY_MAX_DELAY_MS_MAX),
				blockImages: settings.getBlockImages(),
				imageAutoResize: settings.getImageAutoResize(),
				shellCommandPrefix: normalizeShellCommandPrefix(settings.getShellCommandPrefix()),
				defaultProjectTrust: settings.getDefaultProjectTrust(),
				steeringMode: settings.getSteeringMode(),
				followUpMode: settings.getFollowUpMode(),
				shellPath: settings.getShellPath() ?? null,
				npmCommand: formatNpmCommand(settings.getNpmCommand()),
				installTelemetry: settings.getEnableInstallTelemetry(),
				analytics: settings.getEnableAnalytics(),
				httpIdleTimeoutMs: settings.getHttpIdleTimeoutMs(),
				enableSkillCommands: settings.getEnableSkillCommands(),
				// Absent means "Pi decides"; the UI shows that as its own default-set state rather than
				// as an empty selection, which would mean "no built-in tools at all".
				defaultTools: settings.getDefaultTools() ?? [],
			};
		});
	}

	/** Pi's SettingsManager has no setters for these nested values; write the shared
	 * settings.json section directly, preserving sibling keys. */
	async function persistSettingsSectionField(
		section: "compaction" | "retry",
		field: string,
		value: number,
	): Promise<void> {
		await globalSettingsStore.update((settings) => {
			const current = settings[section];
			if (current === undefined) {
				settings[section] = { [field]: value };
				return;
			}
			if (typeof current !== "object" || current === null || Array.isArray(current)) {
				throw new Error(`Pi ${section} settings must contain a JSON object`);
			}
			(current as Record<string, unknown>)[field] = value;
		});
	}

	async function persistPiSettingsUpdate(update: PiSettingsUpdate): Promise<void> {
		if (update.type === "compactionModel") {
			await globalSettingsStore.update((settings) => {
				const compaction = settings.compaction === undefined ? (settings.compaction = {}) : settings.compaction;
				if (typeof compaction !== "object" || compaction === null || Array.isArray(compaction)) {
					throw new Error("Pi compaction settings must contain a JSON object");
				}
				const section = compaction as Record<string, unknown>;
				const overrides = section.modelOverrides === undefined ? (section.modelOverrides = {}) : section.modelOverrides;
				piCompactionModelOverridesSchema.parse(overrides);
				const entries = overrides as Record<string, Record<string, unknown>>;
				const key = `${update.provider}/${update.modelId}`;
				const entry = entries[key] ?? {};
				// Patch only submitted budgets so concurrent field edits cannot overwrite each other.
				if (update.override === null) {
					delete entry.reserveTokens;
					delete entry.keepRecentTokens;
				} else Object.assign(entry, update.override);
				if (Object.keys(entry).length === 0) delete entries[key];
				else entries[key] = entry;
			});
			log.info("updated compaction model override");
			return;
		}
		if (update.type === "compactionTokens") {
			await persistSettingsSectionField("compaction", update.field, update.tokens);
			log.info(`updated ${update.type}.${update.field}`);
			return;
		}
		if (update.type === "defaultTools") {
			// Pi's SettingsManager exposes getDefaultTools but no setter, so write the key directly.
			// An empty selection removes the key so Pi falls back to its own default set instead of
			// starting every session with no built-in tools.
			await globalSettingsStore.update((settings) => {
				if (update.tools.length === 0) delete settings.defaultTools;
				else settings.defaultTools = [...update.tools];
			});
			log.info(`updated defaultTools (${update.tools.length} selected)`);
			return;
		}
		if (update.type === "retryTuning") {
			await persistSettingsSectionField("retry", update.field, update.value);
			log.info(`updated ${update.type}.${update.field}`);
			return;
		}
		const settings = manager();
		assertNoSettingsErrors(settings, "load");
		let reconfigureDispatcher = false;
		switch (update.type) {
			case "defaultModel":
				settings.setDefaultModelAndProvider(update.provider, update.modelId);
				break;
			case "thinkingLevel":
				settings.setDefaultThinkingLevel(update.level);
				break;
			case "compaction":
				settings.setCompactionEnabled(update.enabled);
				break;
			case "cacheWarming":
				settings.setCacheWarmingMode(update.mode);
				break;
			case "retry":
				settings.setRetryEnabled(update.enabled);
				break;
			case "blockImages":
				settings.setBlockImages(update.blocked);
				break;
			case "imageAutoResize":
				settings.setImageAutoResize(update.enabled);
				break;
			case "shellCommandPrefix":
				settings.setShellCommandPrefix(update.prefix?.trim() ? update.prefix.trim() : undefined);
				break;
			case "defaultProjectTrust":
				settings.setDefaultProjectTrust(update.trust);
				break;
			case "shellPath":
				settings.setShellPath(update.path?.trim() ? update.path.trim() : undefined);
				break;
			case "npmCommand":
				settings.setNpmCommand(parseNpmCommand(update.command));
				break;
			case "installTelemetry":
				settings.setEnableInstallTelemetry(update.enabled);
				break;
			case "analytics":
				settings.setEnableAnalytics(update.enabled);
				break;
			case "enableSkillCommands":
				settings.setEnableSkillCommands(update.enabled);
				break;
			case "steeringMode":
				settings.setSteeringMode(update.mode);
				break;
			case "followUpMode":
				settings.setFollowUpMode(update.mode);
				break;
			case "httpIdleTimeoutMs":
				settings.setHttpIdleTimeoutMs(update.timeoutMs);
				reconfigureDispatcher = true;
				break;
			default:
				throw new Error(`Unknown Pi setting update: ${(update as { type: string }).type}`);
		}
		await settings.flush();
		assertNoSettingsErrors(settings, "persist");
		// The undici dispatcher reads the timeout from disk. Rebuild it only after
		// persistence succeeds, otherwise the running process and settings.json diverge.
		if (reconfigureDispatcher) reconfigureHttpDispatcher();
		log.info(`updated ${update.type}`);
	}

	async function updatePiSettings(update: PiSettingsUpdate): Promise<void> {
		// The worker request boundary has parsed the owning settings schema before entering this queue.
		await enqueueGlobalSettingsMutation(() => persistPiSettingsUpdate(update));
	}
	return {
		getPiSettingsRecoveryStatus,
		repairPiHttpIdleTimeout,
		getPiNpmCommandExecutable,
		getPiDefaultTools,
		getPiSettings,
		updatePiSettings,
		network,
		globalSettingsStore,
		mutations,
		dispose,
	};
}

export type PiSettings = ReturnType<typeof createPiSettings>;
