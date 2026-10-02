import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createBashToolDefinition, SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { temporaryDirectory } from "../../../../../test/temporary-directory";
import { createPiModelRuntimes } from "../models/model-runtime";
import { createPiModelProjection } from "../models/model-projection";
import { createPiRuntimeFactory } from "../session/runtime-factory";
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
				builtinExtensions: () => [
					{
						name: "fixture-bash-policy",
						factory: (pi) => pi.registerTool(createBashToolDefinition(cwd)),
					},
				],
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
				expect(
					runtime.resourceLoader.getExtensions().extensions.filter((item) => item.tools.has("generate_image")),
				).toHaveLength(1);
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
					const file = createMcpConfigFile(join(cwd, ".pi", "mcp.json"), "project");
					const signal = new AbortController().signal;
					try {
						const save = async (disabled: boolean) =>
							mcp.write(
								{
									cwd,
									target: "project",
									expectedRevision: (await file.read()).revision,
									name: "fixture",
									change: { kind: "save", server: { command: "node", enabled: !disabled } },
								},
								signal,
							);
						await expect(save(true)).resolves.toEqual({ changed: true, reloadProjects: [cwd] });
						// A local/community MCP adapter remains a consumer with Ling's switch off.
						await writeFile(extension, (await readFile(extension, "utf8")).replace("resource-probe", "mcp"));
						await projects.reloadProjectSettings([cwd]);
						await expect(save(false)).resolves.toEqual({ changed: true, reloadProjects: [cwd] });
						await expect(save(false)).resolves.toEqual({ changed: false, reloadProjects: [] });
					} finally {
						await mcp.dispose();
					}
				}
				if (!loadCatalogResources) {
					await writeFile(
						extension,
						`import { Type } from "@sinclair/typebox";
export default function(pi) {
  for (const [name, defaultActive] of [["fixture_active", true], ["fixture_inactive", false], ["generate_image", true]]) {
    pi.registerTool({ name, label: name, description: name, parameters: Type.Object({}), defaultActive,
      async execute() { return { content: [{ type: "text", text: name }] }; } });
  }
  pi.registerCommand("fixture-register", { description: "Register a deferred tool", handler: async (name) => {
    pi.registerTool({ name, label: name, description: name, parameters: Type.Object({}), exposure: "deferred",
      async execute() { return { content: [{ type: "text", text: name }] }; } });
  } });
}
`,
					);
					await mkdir(join(cwd, ".pi"), { recursive: true });
					const factory = createPiRuntimeFactory({ projects, modelProjection: createPiModelProjection(modelRuntimes) });
					for (const selection of [
						{
							global: { defaultTools: ["read", "+codemode"] },
							project: { defaultTools: ["-codemode", "+tool_search"] },
							expected: ["read", "codemode", "tool_search", "fixture_active"],
						},
						{ global: { defaultTools: [] }, project: {}, expected: ["read", "codemode", "fixture_active"] },
						{ global: {}, project: {}, expected: ["read", "codemode", "fixture_active"] },
						{
							global: {},
							project: {},
							previousDefaults: ["read"],
							expected: ["read", "bash", "edit", "write", "codemode", "fixture_active"],
						},
						{
							global: { defaultTools: ["read", "bash", "grep"] },
							project: {},
							previousDefaults: ["read", "bash"],
							expected: ["read", "codemode", "grep", "fixture_active"],
						},
						{
							global: {},
							project: {},
							previousExtensions: ["fixture_active"],
							expected: ["read", "codemode"],
						},
					]) {
						await writeFile(join(agentDir, "settings.json"), JSON.stringify(selection.global));
						await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify(selection.project));
						await projects.reloadProjectSettings([cwd]);
						const manager = SessionManager.inMemory(cwd);
						const runtime = await factory.createRuntimeForSession({ cwd, sessionId: manager.getSessionId() }, manager, {
							model: null,
							thinkingLevel: "off",
							scopedModels: [],
							activeToolNames: ["read", "codemode"],
							availableToolNames: [
								"read",
								"bash",
								"edit",
								"write",
								"grep",
								"codemode",
								...(selection.previousExtensions ?? []),
							],
							defaultToolNames: selection.previousDefaults ?? ["read", "bash", "edit", "write"],
							extensionFlagValues: new Map(),
						});
						try {
							expect(runtime.session.getActiveToolNames().sort()).toEqual(
								[...selection.expected, "generate_image"].sort(),
							);
							expect(
								runtime.services.resourceLoader
									.getExtensions()
									.extensions.filter((item) => item.tools.has("generate_image"))
									.map((item) => item.path),
							).toEqual([extension]);
						} finally {
							await runtime.dispose();
							projects.releasePiRuntimeServices(runtime.services);
						}
					}
					await writeFile(join(agentDir, "settings.json"), "{}");
					await projects.reloadProjectSettings([cwd]);
					for (const reload of [false, true]) {
						const manager = SessionManager.inMemory(cwd);
						const rootId = manager.appendMessage({
							role: "system",
							content: "Fixture root",
							toolsAdded: [{ name: "read", description: "read", parameters: { type: "object", properties: {} } }],
							timestamp: 0,
						});
						manager.appendMessage({
							role: "system",
							content: "Fixture",
							toolsAdded: ["read", "bash", "fixture_inactive", "fixture_deferred", "fixture_late"].map((name) => ({
								name,
								description: name,
								parameters: { type: "object", properties: {} },
							})),
							timestamp: 1,
						});
						manager.appendMessage({ role: "system", content: "", toolsRemoved: [{ name: "bash" }], timestamp: 2 });
						const runtime = await factory.createRuntimeForSession(
							{ cwd, sessionId: manager.getSessionId() },
							manager,
							reload
								? {
										model: null,
										thinkingLevel: "off",
										scopedModels: [],
										activeToolNames: ["read", "fixture_inactive", "fixture_deferred", "fixture_late"],
										availableToolNames: [
											"read",
											"bash",
											"edit",
											"write",
											"fixture_active",
											"fixture_inactive",
											"generate_image",
											"fixture_deferred",
											"fixture_late",
										],
										defaultToolNames: ["read", "bash", "edit", "write"],
										extensionFlagValues: new Map(),
									}
								: null,
						);
						try {
							await runtime.session.bindExtensions({});
							expect(runtime.session.getActiveToolNames().sort()).toEqual(["fixture_inactive", "read"]);
							await runtime.session.prompt("/fixture-register fixture_deferred");
							expect(runtime.session.getActiveToolNames().sort()).toEqual([
								"fixture_deferred",
								"fixture_inactive",
								"read",
							]);
							await runtime.session.prompt("/fixture-register fixture_unselected");
							expect(runtime.session.getActiveToolNames()).not.toContain("fixture_unselected");
							// Selection changes and tree navigation own the pending loadout as well.
							if (reload) await runtime.session.navigateTree(rootId);
							else runtime.session.setActiveToolsByName(["read"]);
							await runtime.session.prompt("/fixture-register fixture_late");
							await runtime.session.prompt("/fixture-register fixture_deferred");
							expect(runtime.session.getActiveToolNames()).toEqual(["read"]);
						} finally {
							await runtime.dispose();
							projects.releasePiRuntimeServices(runtime.services);
						}
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
