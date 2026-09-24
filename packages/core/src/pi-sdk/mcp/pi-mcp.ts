import { homedir } from "node:os";
import { join } from "node:path";
import {
	getGenericGlobalConfigPath,
	getPiGlobalConfigPath,
	getProjectConfigPath,
	getProjectPiConfigPath,
	getConfigDiscoveryPaths,
	getServerProvenance,
	loadMcpConfig,
} from "pi-mcp-adapter/config";
import {
	isPiMcpSource,
	MCP_BUNDLED_SOURCE,
	type McpDocument,
	type McpOverview,
	type McpTarget,
	type McpWriteRequest,
	type McpWriteResult,
} from "@ling/contracts/mcp";
import { piPackageSource } from "@ling/contracts/pi-tool-origin";
import { requestCancelled, toError } from "../../ling-error";
import type { PiProjectServices } from "../projects/services";
import { createMcpConfigFile } from "./mcp-config";

export function createPiMcp(projects: Pick<PiProjectServices, "withOpenProject" | "listResourceReloadTargets">) {
	const shutdown = new AbortController();
	const pending = new Set<Promise<unknown>>();
	function run<T>(
		cwd: string | null,
		signal: AbortSignal,
		task: (signal: AbortSignal, cwd: string | null) => Promise<T>,
	): Promise<T> {
		const combined = AbortSignal.any([shutdown.signal, signal]);
		const operation = (async () => {
			combined.throwIfAborted();
			if (cwd === null) return task(combined, null);
			return projects.withOpenProject(cwd, async (services) => {
				if (!services.settingsManager.isProjectTrusted())
					throw new Error("Trust this project before configuring MCP services.");
				return task(combined, services.cwd);
			});
		})().finally(() => pending.delete(operation));
		pending.add(operation);
		return operation;
	}
	function sources(cwd: string | null) {
		const paths: { path: string; scope: "global" | "project"; target: McpTarget | null }[] = [
			{ path: getGenericGlobalConfigPath(), scope: "global", target: "global-shared" },
			{ path: join(homedir(), ".agents", "mcp.json"), scope: "global", target: null },
			{ path: join(homedir(), ".agents", "mcp", "mcp.json"), scope: "global", target: null },
			{ path: getPiGlobalConfigPath(), scope: "global", target: "global" },
		];
		if (cwd !== null)
			paths.push(
				{ path: getProjectConfigPath(cwd), scope: "project", target: "project-shared" },
				{ path: getProjectPiConfigPath(cwd), scope: "project", target: "project" },
			);
		// Exclusive mode is an upstream testing/embedding contract, not another persisted preference.
		return process.env.PI_MCP_CONFIG_MODE?.trim().toLowerCase() === "exclusive"
			? paths.filter((source) => source.target === "global")
			: paths;
	}
	async function readDocument(source: ReturnType<typeof sources>[number], signal: AbortSignal): Promise<McpDocument> {
		try {
			return { ...source, ...(await createMcpConfigFile(source.path).read(signal)), error: null };
		} catch (error) {
			signal.throwIfAborted();
			return { ...source, exists: true, revision: null, servers: null, error: toError(error).message };
		}
	}
	return {
		read(cwd: string | null, signal: AbortSignal): Promise<McpOverview> {
			return run(cwd, signal, async (signal) => {
				const documents = await Promise.all(sources(cwd).map((source) => readDocument(source, signal)));
				if (cwd === null || documents.some((document) => document.error)) return { documents, effective: null };
				// Upstream owns optional ancestor discovery and the credential-aware merge semantics.
				for (const source of getConfigDiscoveryPaths(undefined, cwd)) {
					if (!documents.some((document) => document.path === source.path))
						documents.push(await readDocument({ path: source.path, scope: "project", target: null }, signal));
				}
				if (documents.some((document) => document.error)) return { documents, effective: null };
				const config = loadMcpConfig(undefined, cwd);
				const provenance = getServerProvenance(undefined, cwd);
				signal.throwIfAborted();
				return {
					documents,
					effective: Object.entries(config.mcpServers).map(([name, entry]) => ({
						name,
						disabled: entry.disabled === true,
						transport: entry.command ? "stdio" : entry.url ? "http" : entry.socket ? "socket" : "override",
						source: provenance.get(name)?.path ?? null,
					})),
				};
			});
		},
		write(input: McpWriteRequest, signal: AbortSignal): Promise<McpWriteResult> {
			return run(input.cwd, signal, async (signal, cwd) => {
				const target = sources(cwd).find((source) => source.target === input.target);
				if (!target) throw new Error("This MCP configuration scope is unavailable.");
				const changed = await createMcpConfigFile(target.path).write(input, signal);
				if (!changed) return { changed, reloadProjects: [] };
				const consumers = projects.listResourceReloadTargets((services) => {
					const loaded = services.resourceLoader.getExtensions();
					// Failed extension initialization may be repaired by the configuration edit.
					if (loaded.errors.length) return true;
					return loaded.extensions.some(
						(extension) =>
							isPiMcpSource(piPackageSource(extension.sourceInfo.source)) ||
							// Local and independently installed adapters can own the same public interface.
							extension.tools.has("mcp") ||
							extension.commands.has("mcp"),
					);
				}, MCP_BUNDLED_SOURCE);
				return {
					changed,
					reloadProjects:
						target.scope === "project" && cwd
							? (consumers?.filter((project) => project === cwd) ?? [cwd])
							: (consumers ?? null),
				};
			});
		},
		async dispose() {
			shutdown.abort(requestCancelled("MCP settings are shutting down"));
			await Promise.allSettled(pending);
		},
	};
}
