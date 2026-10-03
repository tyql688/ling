import { SettingsManager } from "@earendil-works/pi-coding-agent";
import {
	PI_GLOBAL_CONFIGURATION_KEYS,
	piConfigurationObjectSchema,
	type PiConfigurationSnapshot,
	type PiConfigurationWrite,
} from "@ling/contracts/pi-configuration";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";
import { createLingError, toError } from "../../ling-error";
import { createPiSettingsFileStore, type PiGlobalSettingsStore } from "./global-settings-store";

function revision(settings: Record<string, unknown>): string {
	return createHash("sha256").update(JSON.stringify(settings)).digest("hex");
}

export function createPiConfiguration(agentDir: string, globalStore: PiGlobalSettingsStore) {
	function target(cwd: string | null) {
		const path = cwd === null ? join(agentDir, "settings.json") : join(cwd, ".pi", "settings.json");
		return { path, store: cwd === null ? globalStore : createPiSettingsFileStore(path) };
	}
	async function read(cwd: string | null, trusted: boolean): Promise<PiConfigurationSnapshot> {
		const { path, store } = target(cwd);
		const [configured, inherited] = await Promise.all([
			store.read(),
			cwd === null ? Promise.resolve<Record<string, unknown>>({}) : globalStore.read(),
		]);
		const global = cwd === null ? configured : inherited;
		const manager = SettingsManager.fromStorage(
			{
				withLock(scope, read) {
					const result = read(JSON.stringify(scope === "global" ? global : cwd === null ? {} : configured));
					if (result !== undefined) throw new Error("Configuration inspection cannot write settings");
				},
			},
			{ projectTrusted: trusted },
		);
		const diagnostics = manager.drainErrors().map(({ scope, error }) => `${scope}: ${error.message}`);
		const resolved: Record<string, unknown> = { ...manager.getSettings() };
		const getters: Record<string, () => unknown> = {
			steeringMode: () => manager.getSteeringMode(),
			followUpMode: () => manager.getFollowUpMode(),
			transport: () => manager.getTransport(),
			compaction: () => ({ ...(resolved.compaction as object), ...manager.getCompactionSettings() }),
			branchSummary: () => ({ ...(resolved.branchSummary as object), ...manager.getBranchSummarySettings() }),
			retry: () => ({
				...(resolved.retry as object),
				...manager.getRetrySettings(),
				provider: manager.getProviderRetrySettings(),
			}),
			modelThinkingLevels: () => manager.getAllModelThinkingLevels(),
			enabledModels: () => manager.getEnabledModels() ?? [],
			defaultTools: () => manager.getDefaultTools() ?? ["read", "bash", "edit", "write"],
			packages: () => manager.getPackages(),
			extensions: () => manager.getExtensionPaths(),
			skills: () => manager.getSkillPaths(),
			prompts: () => manager.getPromptTemplatePaths(),
			themes: () => manager.getThemePaths(),
			cacheWarming: () => manager.getCacheWarmingMode(),
			defaultProjectTrust: () => manager.getDefaultProjectTrust(),
			httpIdleTimeoutMs: () => manager.getHttpIdleTimeoutMs(),
			websocketConnectTimeoutMs: () => manager.getWebSocketConnectTimeoutMs(),
			enableSkillCommands: () => manager.getEnableSkillCommands(),
			enableAnalytics: () => manager.getEnableAnalytics(),
			enableInstallTelemetry: () => manager.getEnableInstallTelemetry(),
			images: () => ({
				...(resolved.images as object),
				autoResize: manager.getImageAutoResize(),
				blockImages: manager.getBlockImages(),
			}),
			warnings: () => manager.getWarnings(),
			thinkingBudgets: () => manager.getThinkingBudgets(),
		};
		for (const [key, read] of Object.entries(getters)) {
			try {
				resolved[key] = read();
			} catch (error) {
				diagnostics.push(`${key}: ${toError(error).message}`);
			}
		}
		for (const key of ["httpProxy", "deviceId"]) {
			if (key in global) resolved[key] = global[key];
			else delete resolved[key];
		}
		return {
			cwd,
			path,
			revision: revision(configured),
			trusted,
			configured: piConfigurationObjectSchema.parse(configured),
			inherited: piConfigurationObjectSchema.parse(inherited),
			resolved: piConfigurationObjectSchema.parse(JSON.parse(JSON.stringify(resolved))),
			diagnostics,
		};
	}
	async function write(request: PiConfigurationWrite, trusted: boolean): Promise<void> {
		if (request.cwd !== null && !trusted) throw new Error("Trust this project before editing its Pi configuration");
		const { store } = target(request.cwd);
		await store.update((current) => {
			if (revision(current) !== request.revision)
				throw createLingError({
					code: "PI_CONFIGURATION_CHANGED",
					category: "validation",
					retryable: true,
					message: "Pi configuration changed. Refresh and review before saving; your draft is preserved.",
				});
			if (request.cwd !== null)
				for (const key of PI_GLOBAL_CONFIGURATION_KEYS) {
					if (Object.hasOwn(request.settings, key) && !isDeepStrictEqual(current[key], request.settings[key]))
						throw new Error(`${key} belongs to global Pi settings`);
				}
			const next = SettingsManager.inMemory(request.settings);
			next.getCompactionSettings();
			next.getHttpIdleTimeoutMs();
			next.getDefaultTools();
			for (const key of Object.keys(current)) if (!Object.hasOwn(request.settings, key)) delete current[key];
			Object.assign(current, request.settings);
		});
	}
	return { read, write };
}
