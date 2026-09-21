import type { ConfiguredPackage, PluginResourceInfo } from "@ling/contracts/plugin";
import { basename, dirname, extname, isAbsolute, relative, sep } from "node:path";
import {
	type PluginMutationHostResult,
	type PluginPackageScope,
	type PluginResolvedInventory,
	type PluginUpdate,
	PLUGIN_HOST_PROTOCOL_VERSION,
} from "@ling/core/plugin-host/protocol";
import { normalizePluginSource } from "@ling/core/plugin-host/source";
import { waitForOperation } from "@ling/core/ling-error";
import type { PiWorkerClient } from "../pi/pi-worker-client";
import type { PluginHostClientTransport } from "./client-transport";

const DEFAULT_READ_DEADLINE_MS = 60_000;
const DEFAULT_UPDATE_CHECK_DEADLINE_MS = 2 * 60_000;

function readDeadline(deadlineAt: number | undefined, durationMs: number): number {
	return deadlineAt ?? Date.now() + durationMs;
}

function pluginResourceName(resource: PluginResolvedInventory["resources"][number]): string {
	const file = basename(resource.path);
	if (resource.kind === "skill" && file.toLowerCase() === "skill.md") return basename(dirname(resource.path));
	const extension = extname(file);
	if (resource.kind === "extension" && /^index\.(?:[cm]?[jt]s)$/iu.test(file)) return basename(dirname(resource.path));
	return extension ? file.slice(0, -extension.length) : file;
}

function pluginResourceRelativePath(resource: PluginResolvedInventory["resources"][number]): string {
	const baseDir = resource.metadata.baseDir;
	if (baseDir === null) return basename(resource.path);
	const value = relative(baseDir, resource.path);
	return value.length > 0 && !isAbsolute(value) && value !== ".." && !value.startsWith(`..${sep}`)
		? value
		: basename(resource.path);
}

interface PluginMutationTarget {
	cwd: string;
	source: string;
	scope: PluginPackageScope;
	deadlineAt: number;
}

interface PluginUpdateTarget {
	cwd: string;
	source: string | null;
	scope: PluginPackageScope | "all";
	deadlineAt: number;
	projectTrusted: boolean;
}

export function createPluginClient({
	requestPluginHost,
	projectPiConfig,
}: {
	requestPluginHost: PluginHostClientTransport["requestPluginHost"];
	projectPiConfig: PiWorkerClient["projectPiConfig"];
}) {
	async function resolveConfiguredPlugins(
		cwd: string,
		signal?: AbortSignal,
		deadlineAt?: number,
	): Promise<ConfiguredPackage[]> {
		const { trusted } = await waitForOperation(projectPiConfig(cwd), signal);
		const inventory = await requestPluginHost<PluginResolvedInventory>(
			{
				protocolVersion: PLUGIN_HOST_PROTOCOL_VERSION,
				method: "resolve",
				projectTrusted: trusted,
				cwd,
				deadlineAt: readDeadline(deadlineAt, DEFAULT_READ_DEADLINE_MS),
			},
			signal,
		);
		const resourcesByPackage = new Map<string, PluginResourceInfo[]>();
		for (const resource of inventory.resources) {
			if (resource.metadata.origin !== "package" || resource.metadata.scope === "temporary") continue;
			const scope = resource.metadata.scope === "project" ? "project" : "global";
			const key = `${scope}\u0000${resource.metadata.source}`;
			const resources = resourcesByPackage.get(key) ?? [];
			resources.push({
				kind: resource.kind,
				name: pluginResourceName(resource),
				relativePath: pluginResourceRelativePath(resource),
				enabled: resource.enabled,
			});
			resourcesByPackage.set(key, resources);
		}
		const missingSources = new Set(inventory.missingSources);
		return inventory.configuredPackages.map((pkg) => {
			const resources = (resourcesByPackage.get(`${pkg.scope}\u0000${pkg.source}`) ?? []).sort(
				(a, b) => a.kind.localeCompare(b.kind) || a.relativePath.localeCompare(b.relativePath),
			);
			const counts: ConfiguredPackage["counts"] = { extension: 0, skill: 0, prompt: 0, theme: 0 };
			for (const resource of resources) if (resource.enabled) counts[resource.kind] += 1;
			const activeCount = Object.values(counts).reduce((total, count) => total + count, 0);
			return {
				...pkg,
				resolution:
					pkg.installedPath === null || missingSources.has(pkg.source)
						? "missing"
						: activeCount > 0
							? "loaded"
							: "no-active-resources",
				counts,
				resources,
			};
		});
	}

	async function checkPluginUpdates(cwd: string, signal?: AbortSignal, deadlineAt?: number): Promise<PluginUpdate[]> {
		const { trusted } = await waitForOperation(projectPiConfig(cwd), signal);
		return requestPluginHost<{ updates: PluginUpdate[] }>(
			{
				protocolVersion: PLUGIN_HOST_PROTOCOL_VERSION,
				method: "checkUpdates",
				projectTrusted: trusted,
				cwd,
				deadlineAt: readDeadline(deadlineAt, DEFAULT_UPDATE_CHECK_DEADLINE_MS),
			},
			signal,
		).then((result) => result.updates);
	}

	function installPlugin(target: PluginMutationTarget, signal?: AbortSignal): Promise<PluginMutationHostResult> {
		const source = normalizePluginSource(target.source);
		return requestPluginHost(
			{ protocolVersion: PLUGIN_HOST_PROTOCOL_VERSION, method: "install", ...target, source },
			signal,
		);
	}

	function removePlugin(target: PluginMutationTarget, signal?: AbortSignal): Promise<PluginMutationHostResult> {
		const source = normalizePluginSource(target.source);
		return requestPluginHost(
			{ protocolVersion: PLUGIN_HOST_PROTOCOL_VERSION, method: "remove", ...target, source },
			signal,
		);
	}

	async function updatePlugins(target: PluginUpdateTarget, signal?: AbortSignal): Promise<PluginMutationHostResult> {
		const source = target.source === null ? null : normalizePluginSource(target.source);
		return requestPluginHost(
			{ protocolVersion: PLUGIN_HOST_PROTOCOL_VERSION, method: "update", ...target, source },
			signal,
		);
	}
	return { resolveConfiguredPlugins, checkPluginUpdates, installPlugin, removePlugin, updatePlugins };
}

export type PluginClient = ReturnType<typeof createPluginClient>;
