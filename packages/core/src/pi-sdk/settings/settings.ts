import {
	type PiSettingsRecoveryStatus,
	type PiSettingsSnapshot,
	type PiSettingsUpdate,
	piCompactionModelOverridesSchema,
	PI_SETTINGS_NPM_COMMAND_MAX_CHARS,
	PI_DEFAULT_TOOL_NAMES,
} from "@ling/contracts/pi-settings";
import { z } from "zod";
import { assertNpmCommandParts, parseNpmCommand } from "@ling/contracts/npm-command";
import { homedir } from "node:os";
import { createLogger } from "../../logger";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { PiSettingsManager } from "../types";
import { createPiGlobalSettingsStore } from "./global-settings-store";
import { createPiHttpProxy } from "./http-proxy";
import { createPiSettingsMutations } from "./settings-mutation";
import { createPiConfiguration } from "./configuration";
import { createPiMcpActivation } from "./mcp-activation";

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

export function createPiSettings(agentDir: string) {
	const globalSettingsStore = createPiGlobalSettingsStore(agentDir);
	const configuration = createPiConfiguration(agentDir, globalSettingsStore);
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
		return SettingsManager.create(homedir(), agentDir, { projectTrusted: false });
	}

	function getPiNpmCommandExecutable(): string {
		const settings = manager();
		assertNoSettingsErrors(settings, "load");
		const command = settings.getNpmCommand();
		if (!command || command.length === 0) return "npm";
		assertNpmCommandParts(command);
		return command[0];
	}

	async function getPiSettings(): Promise<PiSettingsSnapshot> {
		return enqueueGlobalSettingsMutation(async () => {
			// Async reads must not contend with Pi's synchronous lock retry on this same thread.
			const settings = SettingsManager.inMemory(await globalSettingsStore.read());
			assertNoSettingsErrors(settings, "load");
			const retrySettings = settings.getRetrySettings();
			const codemode = settings.getSettings().codemode;
			const compactionModelOverrides = piCompactionModelOverridesSchema.parse(
				settings.getGlobalSettings().compaction?.modelOverrides ?? {},
			);
			return {
				defaultProvider: settings.getDefaultProvider() ?? null,
				defaultModel: settings.getDefaultModel() ?? null,
				defaultThinkingLevel: settings.getDefaultThinkingLevel() ?? null,
				compactionEnabled: settings.getCompactionEnabled(),
				compactionReserveTokens: settings.getCompactionReserveTokens(),
				compactionKeepRecentTokens: settings.getCompactionKeepRecentTokens(),
				compactionModelOverrides,
				cacheWarming: settings.getCacheWarmingMode(),
				retryEnabled: settings.getRetryEnabled(),
				retryMaxRetries: retrySettings.maxRetries,
				retryBaseDelayMs: retrySettings.baseDelayMs,
				retryMaxAgentDelayMs: retrySettings.maxAgentDelayMs,
				blockImages: settings.getBlockImages(),
				imageAutoResize: settings.getImageAutoResize(),
				shellCommandPrefix: settings.getShellCommandPrefix() ?? null,
				defaultProjectTrust: settings.getDefaultProjectTrust(),
				steeringMode: settings.getSteeringMode(),
				followUpMode: settings.getFollowUpMode(),
				shellPath: settings.getShellPath() ?? null,
				npmCommand: formatNpmCommand(settings.getNpmCommand()),
				installTelemetry: settings.getEnableInstallTelemetry(),
				analytics: settings.getEnableAnalytics(),
				httpIdleTimeoutMs: settings.getHttpIdleTimeoutMs(),
				enableSkillCommands: settings.getEnableSkillCommands(),
				defaultTools: settings.getDefaultTools() ?? [...PI_DEFAULT_TOOL_NAMES],
				defaultToolsConfigured: settings.getDefaultTools() !== undefined,
				codemode: {
					mode: codemode?.mode === "only" ? "only" : "on",
					inlineBudget:
						typeof codemode?.inlineBudget === "number" &&
						Number.isFinite(codemode.inlineBudget) &&
						codemode.inlineBudget >= 0
							? codemode.inlineBudget
							: 3000,
				},
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
		if (update.type === "codemode") {
			await globalSettingsStore.update((settings) => {
				const current = settings.codemode;
				if (current !== undefined && (typeof current !== "object" || current === null || Array.isArray(current)))
					throw new Error("Pi codemode settings must contain a JSON object");
				settings.codemode = { ...current, ...update.settings };
			});
			return;
		}
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
			// Pi's SettingsManager exposes getDefaultTools but no setter, so write the canonical key.
			await globalSettingsStore.update((settings) => {
				if (update.tools === null) delete settings.defaultTools;
				else if (
					Array.isArray(settings.defaultTools) &&
					settings.defaultTools.every((entry) => typeof entry === "string") &&
					settings.defaultTools.some((entry) => entry.startsWith("+") || entry.startsWith("-"))
				) {
					const current = SettingsManager.inMemory({ defaultTools: settings.defaultTools }).getDefaultTools() ?? [
						...PI_DEFAULT_TOOL_NAMES,
					];
					const requested = new Set(update.tools);
					const changed = new Set([
						...current.filter((name) => !requested.has(name)),
						...update.tools.filter((name) => !current.includes(name)),
					]);
					settings.defaultTools = [
						...settings.defaultTools.filter(
							(entry) => !(entry.startsWith("+") || entry.startsWith("-")) || !changed.has(entry.slice(1)),
						),
						...[...changed].map((name) => `${requested.has(name) ? "+" : "-"}${name}`),
					];
				} else settings.defaultTools = [...update.tools];
			});
			log.info(`updated defaultTools (${update.tools === null ? "default" : update.tools.length})`);
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

	/** Shares Pi's installation identity across project logins under its canonical settings lock. */
	function getPiDeviceId(): Promise<string> {
		return enqueueGlobalSettingsMutation(() =>
			globalSettingsStore.transact(async (settings) => {
				const manager = SettingsManager.inMemory(settings);
				const id = z.uuid().parse(manager.getOrCreateDeviceId());
				await manager.flush();
				if (settings.deviceId === id) return { commit: false, result: id };
				settings.deviceId = id;
				return { commit: true, result: id };
			}),
		);
	}
	return {
		configuration,
		mcpActivation: createPiMcpActivation(agentDir, globalSettingsStore, mutations),
		getPiDeviceId,
		getPiSettingsRecoveryStatus,
		repairPiHttpIdleTimeout,
		getPiNpmCommandExecutable,
		getPiSettings,
		updatePiSettings,
		network,
		globalSettingsStore,
		mutations,
		dispose,
	};
}

export type PiSettings = ReturnType<typeof createPiSettings>;
