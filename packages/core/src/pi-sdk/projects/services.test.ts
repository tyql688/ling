import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { temporaryDirectory } from "../../../../../test/temporary-directory";
import { createPiModelRuntimes } from "../models/model-runtime";
import { createLingSkillResources } from "../resources/skill-toggles";
import { createPiTurnLifecycle } from "../session/turn-lifecycle";
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
			await mkdir(join(agentDir, "extensions"), { recursive: true });
			await mkdir(cwd);
			await writeFile(loads, "");
			await writeFile(
				extension,
				`import { appendFileSync } from "node:fs";
export default function(pi) {
  appendFileSync(${JSON.stringify(loads)}, "loaded\\n");
  pi.registerCommand("resource-probe", { description: "Fixture", handler: async () => {} });
}
`,
			);
			const countLoads = async () => (await readFile(loads, "utf8")).split("\n").filter(Boolean).length;
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
						todo: false,
						permissions: false,
						questions: false,
						"background-tasks": false,
						schedules: false,
						voice: false,
					},
					voice: null,
					todo: null,
					permissions: null,
				}),
			});
			try {
				await projects.openProject(cwd);
				expect(await countLoads()).toBe(loadCatalogResources ? 1 : 0);
				const sessionManager = SessionManager.inMemory(cwd);
				const runtime = await projects.acquirePiRuntimeServices(cwd, { sessionManager });
				expect(await countLoads()).toBe(loadCatalogResources ? 2 : 1);
				expect(
					runtime.resourceLoader.getExtensions().extensions.some((item) => item.commands.has("resource-probe")),
				).toBe(true);
				projects.releasePiRuntimeServices(runtime);
				await projects.reloadProjectSettings([cwd]);
				expect(await countLoads()).toBe(loadCatalogResources ? 3 : 1);
				const replacement = await projects.acquirePiRuntimeServices(cwd, {
					sessionManager,
					extensionFlagValues: new Map(),
				});
				expect(await countLoads()).toBe(loadCatalogResources ? 4 : 2);
				expect(
					replacement.resourceLoader.getExtensions().extensions.some((item) => item.commands.has("resource-probe")),
				).toBe(true);
				projects.releasePiRuntimeServices(replacement);
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
