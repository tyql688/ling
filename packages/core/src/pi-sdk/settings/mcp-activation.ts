import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { z } from "zod";
import type { PiGlobalSettingsStore } from "./global-settings-store";
import type { createPiSettingsMutations } from "./settings-mutation";

/** The MCP switch edits Pi's canonical extension filter; project overrides remain Pi-owned. */
export function createPiMcpActivation(
	agentDir: string,
	store: PiGlobalSettingsStore,
	mutations: ReturnType<typeof createPiSettingsMutations>,
) {
	let cached: { key: string; enabled: Promise<boolean> } | undefined;
	function resolve(settings: Record<string, unknown>): Promise<boolean> {
		const extensions = z.array(z.string()).parse(settings.extensions ?? []);
		const key = JSON.stringify(extensions);
		if (cached?.key === key) return cached.enabled;
		// Package installation is irrelevant to the built-in's filter. Pi still resolves
		// exact, glob, exclusion and override patterns with its own implementation.
		const manager = SettingsManager.inMemory({ extensions });
		const enabled = new DefaultPackageManager({
			cwd: homedir(),
			agentDir,
			settingsManager: manager,
			builtinExtensions: ["mcp"],
		})
			.resolve()
			.then((inventory) => {
				const resource = inventory.extensions.find((entry) => entry.path === "builtin:mcp");
				if (!resource) throw new Error("Pi did not resolve its built-in MCP extension");
				return resource.enabled;
			});
		cached = { key, enabled };
		void enabled.catch(() => {
			if (cached?.enabled === enabled) cached = undefined;
		});
		return enabled;
	}
	return {
		read: async () => resolve(await store.read()),
		write: (enabled: boolean, expected?: boolean) =>
			mutations.enqueueGlobalSettingsMutation(() =>
				store.transact(async (settings) => {
					const current = await resolve(settings);
					if (expected !== undefined && current !== expected)
						throw new Error("Pi MCP activation changed. Refresh before saving.");
					if (current === enabled) return { commit: false, result: false };
					const filters = z.array(z.string()).parse(settings.extensions ?? []);
					settings.extensions = [
						...filters.filter(
							(entry) => entry !== "+builtin:mcp" && entry !== "-builtin:mcp" && entry !== "!builtin:mcp",
						),
						`${enabled ? "+" : "-"}builtin:mcp`,
					];
					return { commit: true, result: true };
				}),
			),
	};
}
