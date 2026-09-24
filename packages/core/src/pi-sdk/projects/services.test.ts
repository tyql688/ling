import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { temporaryDirectory } from "../../../../../test/temporary-directory";
import { createPiModelRuntimes } from "../models/model-runtime";
import { createLingSkillResources } from "../resources/skill-toggles";
import { createPiTurnLifecycle } from "../session/turn-lifecycle";
import { createPiMcp } from "../mcp/pi-mcp";
import { createMcpConfigFile } from "../mcp/mcp-config";
import { createPiProjectServices } from "./services";

// Real SDK imports and both resource graphs reload from disk; allow room for concurrent filesystem suites.
it("loads a session worker's extensions only for its runtime, including after resource reload", async () => {
	const directory = await temporaryDirectory("pi-project-resources");
	try {
		for (const loadCatalogResources of [true, false]) {
			const root = join(directory, loadCatalogResources ? "control" : "session");
			const agentDir = join(root, "agent");
			const cwd = join(root, "project");
			const loads = join(root, "loads.txt");
			const extension = join(agentDir, "extensions", "probe.ts");
			const bundled = join(root, "bundled.ts");
			await mkdir(join(agentDir, "extensions"), { recursive: true });
			await mkdir(cwd);
			await writeFile(loads, "");
			await writeFile(
				extension,
				`import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(loads)}, "imported\\n");
export default function(pi) {
  appendFileSync(${JSON.stringify(loads)}, "loaded\\n");
  pi.registerCommand("resource-probe", { description: "Fixture", handler: async () => {} });
}
`,
			);
			await writeFile(
				bundled,
				`import { appendFileSync } from "node:fs";
export default function(pi) {
  appendFileSync(${JSON.stringify(loads)}, "bundled-loaded\\n");
  pi.registerCommand("bundled-probe", { description: "Fixture", handler: async () => {} });
}
`,
			);
			const countBundledLoads = async () =>
				(await readFile(loads, "utf8")).split("\n").filter((line) => line === "bundled-loaded").length;
			const countLoads = async () =>
				(await readFile(loads, "utf8")).split("\n").filter((line) => line === "loaded").length;
			const countImports = async () =>
				(await readFile(loads, "utf8")).split("\n").filter((line) => line === "imported").length;
			const modelRuntimes = createPiModelRuntimes(agentDir);
			const turnLifecycle = createPiTurnLifecycle({ start: async () => {}, finish: async () => {} });
			const projects = createPiProjectServices({
				loadCatalogResources,
				agentDir,
				modelRuntimes,
				turnLifecycle,
				skillResources: createLingSkillResources(),
				builtinExtensions: () => [],
				resolveProjectTrust: async () => true,
				readAdapterPlan: async () => ({
					features: {
						todo: true,
						permissions: false,
						questions: false,
						"background-tasks": false,
						schedules: false,
						voice: false,
						mcp: false,
					},
					voice: null,
					mcp: null,
					todo: bundled,
					permissions: null,
				}),
			});
			try {
				const usesProbe = (services: ReturnType<typeof projects.getPiServices>) =>
					services.resourceLoader
						.getExtensions()
						.extensions.some((extension) => extension.commands.has("resource-probe"));
				const opening = projects.openProject(cwd);
				expect(projects.listResourceReloadTargets(usesProbe)).toBeUndefined();
				await opening;
				expect(await countBundledLoads()).toBe(0);
				expect(await countLoads()).toBe(loadCatalogResources ? 1 : 0);
				expect(projects.listResourceReloadTargets(usesProbe)).toEqual(loadCatalogResources ? [cwd] : []);
				const sessionManager = SessionManager.inMemory(cwd);
				const runtime = await projects.acquirePiRuntimeServices(cwd, { sessionManager });
				expect(await countLoads()).toBe(loadCatalogResources ? 2 : 1);
				expect(await countBundledLoads()).toBe(1);
				expect(projects.listResourceReloadTargets(usesProbe)).toEqual([cwd]);
				expect(
					runtime.resourceLoader.getExtensions().extensions.some((item) => item.commands.has("resource-probe")),
				).toBe(true);
				projects.releasePiRuntimeServices(runtime);
				const beforeAdapterChange = projects.getPiServices(cwd);
				const priorModels = beforeAdapterChange.modelRuntime;
				const priorLoader = beforeAdapterChange.resourceLoader;
				await projects.reloadProjectSettings([cwd], "adapters");
				expect(beforeAdapterChange.modelRuntime).toBe(priorModels);
				expect(beforeAdapterChange.resourceLoader).toBe(priorLoader);
				expect(await countLoads()).toBe(loadCatalogResources ? 2 : 1);
				const reloading = projects.reloadProjectSettings([cwd]);
				expect(projects.listResourceReloadTargets(usesProbe)).toBeUndefined();
				await reloading;
				expect(await countLoads()).toBe(loadCatalogResources ? 3 : 1);
				expect(await countBundledLoads()).toBe(1);
				const replacement = await projects.acquirePiRuntimeServices(cwd, {
					sessionManager,
					extensionFlagValues: new Map(),
				});
				expect(await countLoads()).toBe(loadCatalogResources ? 4 : 2);
				expect(
					replacement.resourceLoader.getExtensions().extensions.some((item) => item.commands.has("resource-probe")),
				).toBe(true);
				projects.releasePiRuntimeServices(replacement);
				const importsBefore = await countImports();
				await projects.reloadProjectSettings([cwd], "configuration");
				const configured = await projects.acquirePiRuntimeServices(cwd, {
					sessionManager,
					extensionFlagValues: new Map(),
					mode: "configuration",
				});
				expect(await countImports()).toBe(importsBefore);
				expect(await countLoads()).toBe(loadCatalogResources ? 6 : 3);
				projects.releasePiRuntimeServices(configured);
				await projects.reloadProjectSettings([cwd]);
				const fresh = await projects.acquirePiRuntimeServices(cwd, { sessionManager, extensionFlagValues: new Map() });
				expect(await countImports()).toBeGreaterThan(importsBefore);
				projects.releasePiRuntimeServices(fresh);
				if (loadCatalogResources) {
					const mcp = createPiMcp(projects);
					const file = createMcpConfigFile(join(cwd, ".pi", "mcp.json"));
					const signal = new AbortController().signal;
					try {
						const save = async (disabled: boolean) =>
							mcp.write(
								{
									cwd,
									target: "project",
									expectedRevision: (await file.read()).revision,
									name: "fixture",
									change: { kind: "toggle", disabled },
								},
								signal,
							);
						await expect(save(true)).resolves.toEqual({ changed: true, reloadProjects: [] });
						// A local/community MCP adapter remains a consumer with Ling's switch off.
						await writeFile(extension, (await readFile(extension, "utf8")).replace("resource-probe", "mcp"));
						await projects.reloadProjectSettings([cwd]);
						await expect(save(false)).resolves.toEqual({ changed: true, reloadProjects: [cwd] });
						await expect(save(false)).resolves.toEqual({ changed: false, reloadProjects: [] });
					} finally {
						await mcp.dispose();
					}
				}
			} finally {
				try {
					await projects.dispose(async () => {});
				} finally {
					turnLifecycle.dispose();
					await modelRuntimes.dispose();
				}
			}
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}, 20_000);
