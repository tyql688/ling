import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir, type LoadedMcpConfig, type McpServerConfig } from "@earendil-works/pi-coding-agent";
import {
	mcpScopedServerSchema,
	mcpConfiguredServerSchema,
	isMcpProjectOverride,
	mcpServerNameSchema,
	mcpServerNamespace,
	type McpDocument,
	type McpOverview,
	type McpTarget,
	type McpWriteRequest,
	type McpWriteResult,
} from "@ling/contracts/mcp";
import { requestCancelled, toError } from "../../ling-error";
import type { PiProjectServices } from "../projects/services";
import { createMcpConfigFile } from "./mcp-config";

function sources(agentDir: string, cwd: string | null) {
	const paths: { path: string; scope: "global" | "project"; target: McpTarget }[] = [
		{ path: join(agentDir, "mcp.json"), scope: "global", target: "global" },
	];
	if (cwd !== null) paths.push({ path: join(cwd, ".pi", "mcp.json"), scope: "project", target: "project" });
	return paths;
}

/** One bounded configuration snapshot feeds both native editing and the official extension. */
export async function readPiMcpConfiguration(agentDir: string, cwd: string | null, signal?: AbortSignal) {
	const documents: McpDocument[] = [];
	const loaded: LoadedMcpConfig = {
		servers: [],
		errors: [],
		...(cwd === null ? {} : { projectConfig: join(cwd, ".pi", "mcp.json") }),
	};
	const entries = new Map<string, LoadedMcpConfig["servers"][number]>();
	for (const source of sources(agentDir, cwd)) {
		try {
			const { config, ...document } = await createMcpConfigFile(source.path, source.scope).read(signal);
			documents.push({ ...source, ...document, error: null });
			if (typeof config.autoEnableCodemode === "boolean") loaded.autoEnableCodemode = config.autoEnableCodemode;
			else if (config.autoEnableCodemode !== undefined)
				loaded.errors.push(`${source.path}: autoEnableCodemode must be a boolean.`);
			for (const field of ["mcp-servers", "imports", "settings"])
				if (config[field] !== undefined)
					loaded.errors.push(
						`${source.path}: ${field} is not supported by official Pi MCP. Use mcpServers and autoEnableCodemode.`,
					);
			for (const [name, value] of Object.entries(document.servers)) {
				const inherited = entries.get(name);
				// An invalid project entry must not activate a same-name global service.
				entries.delete(name);
				const validName = mcpServerNameSchema.safeParse(name);
				if (!validName.success) {
					loaded.errors.push(`${source.path}: ${name}: Use 1–200 letters, digits, _ and - in server names.`);
					continue;
				}
				const parsed = mcpScopedServerSchema.safeParse({ scope: source.scope, server: value });
				if (!parsed.success) {
					loaded.errors.push(
						`${source.path}: ${name}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
					);
					continue;
				}
				const conflict = [...entries.keys()].find((other) => mcpServerNamespace(other) === mcpServerNamespace(name));
				if (conflict) {
					loaded.errors.push(
						`${source.path}: server "${name}" conflicts with "${conflict}" in namespace ${mcpServerNamespace(name)}.`,
					);
					continue;
				}
				if (source.scope === "project" && isMcpProjectOverride(parsed.data.server)) {
					if (!inherited) {
						loaded.errors.push(`${source.path}: ${name}: A project override requires a valid global MCP service.`);
						continue;
					}
					const config = mcpConfiguredServerSchema.parse({ ...inherited.config, ...parsed.data.server });
					entries.set(name, { ...inherited, config: config as McpServerConfig, override: source.path });
					continue;
				}
				// The boundary schema requires one complete transport; the SDK type represents that union.
				entries.set(name, {
					name,
					config: parsed.data.server as McpServerConfig,
					source: source.path,
					scope: source.scope,
				});
			}
		} catch (cause) {
			signal?.throwIfAborted();
			const error = toError(cause).message;
			documents.push({ ...source, exists: true, revision: null, servers: null, error });
			loaded.errors.push(`${source.path}: ${error}`);
		}
	}
	loaded.servers = [...entries.values()];
	return { documents, loaded };
}

export function createPiMcp(projects: Pick<PiProjectServices, "withOpenProject">) {
	const shutdown = new AbortController();
	const pending = new Set<Promise<unknown>>();
	function run<T>(
		cwd: string | null,
		signal: AbortSignal,
		task: (signal: AbortSignal, cwd: string | null, agentDir: string) => Promise<T>,
	): Promise<T> {
		const combined = AbortSignal.any([shutdown.signal, signal]);
		const operation = (async () => {
			combined.throwIfAborted();
			if (cwd === null) return task(combined, null, getAgentDir());
			return projects.withOpenProject(cwd, async (services) => {
				if (!services.settingsManager.isProjectTrusted())
					throw new Error("Trust this project before configuring MCP services.");
				return task(combined, services.cwd, services.agentDir);
			});
		})().finally(() => pending.delete(operation));
		pending.add(operation);
		return operation;
	}
	return {
		read(cwd: string | null, signal: AbortSignal): Promise<McpOverview> {
			return run(cwd, signal, async (signal, cwd, agentDir) => {
				const { documents, loaded } = await readPiMcpConfiguration(agentDir, cwd, signal);
				const notices = [...loaded.errors];
				const legacyPaths = [
					join(agentDir, "mcp-adapter.json"),
					...(cwd ? [join(cwd, ".pi", "mcp-adapter.json")] : []),
					join(homedir(), ".config", "mcp", "mcp.json"),
					join(homedir(), ".agents", "mcp.json"),
					join(homedir(), ".agents", "mcp", "mcp.json"),
					...(cwd ? [join(cwd, ".mcp.json")] : []),
				];
				for (const path of legacyPaths) {
					try {
						const { config: _config, ...document } = await createMcpConfigFile(path, "global").read(signal);
						if (!document.exists) continue;
						documents.push({
							path,
							scope:
								cwd && [join(cwd, ".mcp.json"), join(cwd, ".pi", "mcp-adapter.json")].includes(path)
									? "project"
									: "global",
							target: null,
							...document,
							error: null,
						});
						notices.push(
							`Official Pi MCP reads ${join(agentDir, "mcp.json")} and trusted project .pi/mcp.json. Import any required services from ${path} into one of those files.`,
						);
					} catch (cause) {
						signal.throwIfAborted();
						notices.push(`${path}: ${toError(cause).message}`);
					}
				}
				return {
					documents,
					notices,
					effective: loaded.servers.map(({ name, config, source, override }) => ({
						name,
						disabled: config.enabled === false,
						transport: "url" in config ? "http" : "stdio",
						exposure: config.exposure ?? "codemode",
						...(config.description === undefined ? {} : { description: config.description }),
						...("url" in config && config.auth ? { authProvider: config.auth.provider } : {}),
						source,
						...(override === undefined ? {} : { override }),
					})),
				};
			});
		},
		write(input: McpWriteRequest, signal: AbortSignal): Promise<McpWriteResult> {
			return run(input.cwd, signal, async (signal, cwd, agentDir) => {
				const target = sources(agentDir, cwd).find((source) => source.target === input.target);
				if (!target) throw new Error("This MCP configuration scope is unavailable.");
				const changed = await createMcpConfigFile(target.path, target.scope).write(input, signal);
				return { changed, reloadProjects: !changed ? [] : target.scope === "project" && cwd ? [cwd] : null };
			});
		},
		async dispose() {
			shutdown.abort(requestCancelled("MCP settings are shutting down"));
			await Promise.allSettled(pending);
		},
	};
}
