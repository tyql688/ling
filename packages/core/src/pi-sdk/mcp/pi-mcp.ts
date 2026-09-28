import { homedir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DefaultPackageManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import * as bundledConfig from "pi-mcp-adapter/config";
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
import type { PiAgentSessionServices } from "../types";
import { createSettingsManager } from "../sdk-factories";
import { createMcpConfigFile } from "./mcp-config";
import { supportsPiMcp } from "./mcp-extension";

type McpConfigApi = Pick<
	typeof bundledConfig,
	| "getGenericGlobalConfigPath"
	| "getPiGlobalConfigPath"
	| "getProjectConfigPath"
	| "getProjectPiConfigPath"
	| "getConfigDiscoveryPaths"
	| "getServerProvenance"
	| "loadMcpConfig"
> &
	Partial<Pick<typeof bundledConfig, "getLegacyPiMcpGlobalConfigPath" | "getLegacyProjectPiMcpConfigPath">>;

/** Configuration must follow the same installed package that takes precedence at runtime. */
async function resolveConfigApi(services?: PiAgentSessionServices): Promise<McpConfigApi> {
	const cwd = services?.cwd ?? homedir();
	const agentDir = services?.agentDir ?? getAgentDir();
	const settingsManager = services?.settingsManager ?? createSettingsManager(cwd, agentDir, { projectTrusted: false });
	const errors = settingsManager.drainErrors();
	if (errors.length)
		throw new AggregateError(
			errors.map(({ error }) => error),
			"Cannot read Pi MCP package settings",
		);
	const inventory = await new DefaultPackageManager({ cwd, agentDir, settingsManager }).resolve();
	const installed = inventory.extensions.find(
		(resource) =>
			(services !== undefined || resource.metadata.scope !== "project") &&
			isPiMcpSource(
				piPackageSource(resource.metadata.origin === "top-level" ? resource.path : resource.metadata.source),
			),
	);
	if (!installed) return bundledConfig;
	if (!(await supportsPiMcp(installed.path)))
		throw new Error(
			"This installed MCP adapter version has not been verified for native settings. Use its original configuration commands.",
		);
	const entry = createRequire(installed.path).resolve("pi-mcp-adapter/config");
	return import(pathToFileURL(entry).href) as Promise<McpConfigApi>;
}

export function createPiMcp(projects: Pick<PiProjectServices, "withOpenProject" | "listResourceReloadTargets">) {
	const shutdown = new AbortController();
	const pending = new Set<Promise<unknown>>();
	function run<T>(
		cwd: string | null,
		signal: AbortSignal,
		task: (signal: AbortSignal, cwd: string | null, configApi: McpConfigApi) => Promise<T>,
	): Promise<T> {
		const combined = AbortSignal.any([shutdown.signal, signal]);
		const operation = (async () => {
			combined.throwIfAborted();
			if (cwd === null) return task(combined, null, await resolveConfigApi());
			return projects.withOpenProject(cwd, async (services) => {
				if (!services.settingsManager.isProjectTrusted())
					throw new Error("Trust this project before configuring MCP services.");
				return task(combined, services.cwd, await resolveConfigApi(services));
			});
		})().finally(() => pending.delete(operation));
		pending.add(operation);
		return operation;
	}
	function sources(cwd: string | null, api: McpConfigApi) {
		const paths: { path: string; scope: "global" | "project"; target: McpTarget | null }[] = [
			{ path: api.getGenericGlobalConfigPath(), scope: "global", target: "global-shared" },
			{ path: join(homedir(), ".agents", "mcp.json"), scope: "global", target: null },
			{ path: join(homedir(), ".agents", "mcp", "mcp.json"), scope: "global", target: null },
			{ path: api.getPiGlobalConfigPath(), scope: "global", target: "global" },
		];
		if (cwd !== null)
			paths.push(
				{ path: api.getProjectConfigPath(cwd), scope: "project", target: "project-shared" },
				{ path: api.getProjectPiConfigPath(cwd), scope: "project", target: "project" },
			);
		// Exclusive mode is an upstream testing/embedding contract, not another persisted preference.
		return process.env.PI_MCP_CONFIG_MODE?.trim().toLowerCase() === "exclusive"
			? paths.filter((source) => source.target === "global")
			: paths;
	}
	async function readDocument(
		source: ReturnType<typeof sources>[number],
		signal: AbortSignal,
		api: McpConfigApi,
	): Promise<McpDocument> {
		try {
			// The verified 3.1 API adds both legacy-path notices and BOM support; 2.37 rejects BOMs.
			const file = createMcpConfigFile(source.path, { allowBom: api.getLegacyPiMcpGlobalConfigPath !== undefined });
			return { ...source, ...(await file.read(signal)), error: null };
		} catch (error) {
			signal.throwIfAborted();
			return { ...source, exists: true, revision: null, servers: null, error: toError(error).message };
		}
	}
	return {
		read(cwd: string | null, signal: AbortSignal): Promise<McpOverview> {
			return run(cwd, signal, async (signal, cwd, api) => {
				const documents = await Promise.all(sources(cwd, api).map((source) => readDocument(source, signal, api)));
				// Keep legacy files visible without editing them or treating their services as active.
				// Unlike the upstream notice helper, bounded reads report malformed files too.
				const legacy: McpDocument[] = [];
				const notices: string[] = [];
				for (const scope of ["global", "project"] as const) {
					const path =
						scope === "global"
							? api.getLegacyPiMcpGlobalConfigPath?.()
							: cwd === null
								? undefined
								: api.getLegacyProjectPiMcpConfigPath?.(cwd);
					const target = documents.find((document) => document.target === scope);
					if (!path || !target || path === target.path) continue;
					const document = await readDocument({ path, scope, target: null }, signal, api);
					if (!document.exists) continue;
					legacy.push(document);
					notices.push(
						`The MCP adapter no longer reads ${path}. Move or merge its configuration into ${target.path} to use those services. The original file has not been changed.`,
					);
				}
				const result = (effective: McpOverview["effective"]): McpOverview => ({
					documents: [...documents, ...legacy],
					notices,
					effective,
				});
				if (cwd === null || documents.some((document) => document.error)) return result(null);
				// Upstream owns optional ancestor discovery and the credential-aware merge semantics.
				for (const source of api.getConfigDiscoveryPaths(undefined, cwd)) {
					if (!documents.some((document) => document.path === source.path))
						documents.push(await readDocument({ path: source.path, scope: "project", target: null }, signal, api));
				}
				if (documents.some((document) => document.error)) return result(null);
				const config = api.loadMcpConfig(undefined, cwd);
				const provenance = api.getServerProvenance(undefined, cwd);
				signal.throwIfAborted();
				return result(
					Object.entries(config.mcpServers).map(([name, entry]) => ({
						name,
						disabled: entry.disabled === true,
						transport: entry.command ? "stdio" : entry.url ? "http" : entry.socket ? "socket" : "override",
						source: provenance.get(name)?.path ?? null,
					})),
				);
			});
		},
		write(input: McpWriteRequest, signal: AbortSignal): Promise<McpWriteResult> {
			return run(input.cwd, signal, async (signal, cwd, api) => {
				const target = sources(cwd, api).find((source) => source.target === input.target);
				if (!target) throw new Error("This MCP configuration scope is unavailable.");
				const changed = await createMcpConfigFile(target.path, {
					allowBom: api.getLegacyPiMcpGlobalConfigPath !== undefined,
				}).write(input, signal);
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
							extension.commands.has("mcp") ||
							extension.commands.has("mcp-adapter"),
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
