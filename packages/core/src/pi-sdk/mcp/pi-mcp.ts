import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir, type LoadedMcpConfig, type McpServerConfig } from "@earendil-works/pi-coding-agent";
import {
	mcpConfiguredServerSchema,
	mcpServerNameSchema,
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
	const loaded: LoadedMcpConfig = { servers: [], errors: [] };
	const entries = new Map<string, LoadedMcpConfig["servers"][number]>();
	for (const source of sources(agentDir, cwd)) {
		try {
			const { config, ...document } = await createMcpConfigFile(source.path).read(signal);
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
				// An invalid project entry must not activate a same-name global service.
				entries.delete(name);
				const validName = mcpServerNameSchema.safeParse(name);
				if (!validName.success) {
					loaded.errors.push(`${source.path}: ${name}: Use 1–200 letters, digits, _ and - in server names.`);
					continue;
				}
				const parsed = mcpConfiguredServerSchema.safeParse(value);
				if (!parsed.success) {
					loaded.errors.push(
						`${source.path}: ${name}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
					);
					continue;
				}
				// The boundary schema requires one complete transport; the SDK type represents that union.
				entries.set(name, { name, config: parsed.data as McpServerConfig, source: source.path, scope: source.scope });
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
						const { config: _config, ...document } = await createMcpConfigFile(path).read(signal);
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
					effective: loaded.servers.map(({ name, config, source }) => ({
						name,
						disabled: config.enabled === false,
						transport: "url" in config ? "http" : "stdio",
						exposure: config.exposure ?? "codemode",
						source,
					})),
				};
			});
		},
		write(input: McpWriteRequest, signal: AbortSignal): Promise<McpWriteResult> {
			return run(input.cwd, signal, async (signal, cwd, agentDir) => {
				const target = sources(agentDir, cwd).find((source) => source.target === input.target);
				if (!target) throw new Error("This MCP configuration scope is unavailable.");
				const changed = await createMcpConfigFile(target.path).write(input, signal);
				return { changed, reloadProjects: !changed ? [] : target.scope === "project" && cwd ? [cwd] : null };
			});
		},
		async dispose() {
			shutdown.abort(requestCancelled("MCP settings are shutting down"));
			await Promise.allSettled(pending);
		},
	};
}
