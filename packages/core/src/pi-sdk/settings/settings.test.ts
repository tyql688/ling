import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DefaultPackageManager, DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { temporaryDirectory } from "../../../../../test/temporary-directory";
import { createPiSettings } from "./settings";
import { createPiSkillCatalog } from "../resources/skills";
import { createLingSkillResources } from "../resources/skill-toggles";
import { settingsSchema } from "../../pi-protocol/domain-payload-schemas";

it("preserves canonical tool selection, Codemode siblings and the installation identity across writers", async () => {
	const agentDir = await temporaryDirectory("pi-feature-settings");
	const owner = createPiSettings(agentDir);
	const second = createPiSettings(agentDir);
	const path = join(agentDir, "settings.json");
	try {
		expect(await owner.getPiSettings()).toMatchObject({
			defaultTools: ["read", "bash", "edit", "write"],
			defaultToolsConfigured: false,
		});
		await writeFile(
			path,
			JSON.stringify({
				defaultTools: ["+codemode", "-write", "+extension_tool"],
				codemode: { inlineBudget: 100, custom: true },
				custom: "preserved",
			}),
		);
		expect(settingsSchema.parse(await owner.getPiSettings()).defaultTools).toEqual([
			"read",
			"bash",
			"edit",
			"codemode",
			"extension_tool",
		]);
		const [id, other] = await Promise.all([
			owner.getPiDeviceId(),
			second.getPiDeviceId(),
			owner.updatePiSettings({ type: "codemode", settings: { mode: "only" } }),
			second.updatePiSettings({ type: "codemode", settings: { inlineBudget: 0 } }),
		]);
		expect(id).toMatch(/^[0-9a-f-]{36}$/);
		expect(other).toBe(id);
		expect(await owner.getPiDeviceId()).toBe(id);
		expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
			deviceId: id,
			codemode: { mode: "only", inlineBudget: 0, custom: true },
			custom: "preserved",
		});
		await owner.updatePiSettings({ type: "defaultTools", tools: [] });
		expect(settingsSchema.parse(await owner.getPiSettings())).toMatchObject({
			defaultTools: [],
			defaultToolsConfigured: true,
		});
		await owner.updatePiSettings({ type: "defaultTools", tools: ["codemode", "extension_tool"] });
		expect(settingsSchema.parse(await owner.getPiSettings()).defaultTools).toEqual(["codemode", "extension_tool"]);
		await owner.updatePiSettings({ type: "defaultTools", tools: null });
		expect(JSON.parse(await readFile(path, "utf8"))).not.toHaveProperty("defaultTools");
		expect(settingsSchema.parse(await owner.getPiSettings())).toMatchObject({
			defaultTools: ["read", "bash", "edit", "write"],
			defaultToolsConfigured: false,
		});
	} finally {
		await Promise.all([owner.dispose(), second.dispose()]);
		await rm(agentDir, { recursive: true, force: true });
	}
});

it("skips unchanged skill switches without rewriting shared Pi settings", async () => {
	const agentDir = await temporaryDirectory("skill-switches");
	const settings = createPiSettings(agentDir);
	const directory = join(agentDir, "builtin", "probe");
	await mkdir(directory, { recursive: true });
	await writeFile(
		join(directory, "SKILL.md"),
		"---\nname: probe\ndescription: Fixture for skill configuration\n---\nFixture.\n",
	);
	vi.stubEnv("LING_BUILTIN_SKILLS_DIR", join(agentDir, "builtin"));
	const catalog = createPiSkillCatalog({
		agentDir,
		settings,
		skillResources: createLingSkillResources(),
		projects: {
			listOpenProjectPaths: () => [],
			getPiServices: () => {
				throw new Error("No open project");
			},
			withOpenProject: async () => {
				throw new Error("No open project");
			},
		},
	});
	const path = join(agentDir, "settings.json");
	try {
		expect(await catalog.setBuiltinSkillsEnabled(true)).toBe(false);
		expect(await catalog.setSkillEnabled("probe", true)).toBe(false);
		await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await catalog.setBuiltinSkillsEnabled(false)).toBe(true);
		expect(await catalog.setSkillEnabled("probe", false)).toBe(true);
		const saved = JSON.stringify(JSON.parse(await readFile(path, "utf8")));
		await writeFile(path, saved);
		expect(await catalog.setBuiltinSkillsEnabled(false)).toBe(false);
		expect(await catalog.setSkillEnabled("probe", false)).toBe(false);
		expect(await readFile(path, "utf8")).toBe(saved);
		expect(await catalog.setSkillEnabled("probe", true)).toBe(true);
	} finally {
		vi.unstubAllEnvs();
		await settings.dispose();
		await rm(agentDir, { recursive: true, force: true });
	}
});

it("updates and resets exact model budgets without erasing canonical settings or unknown sibling fields", async () => {
	const agentDir = await temporaryDirectory("pi-settings");
	const owner = createPiSettings(agentDir);
	const path = join(agentDir, "settings.json");
	try {
		await writeFile(
			path,
			JSON.stringify({
				customSetting: "preserved",
				compaction: {
					reserveTokens: 8192,
					enabled: false,
					customPolicy: true,
					modelOverrides: {
						"test/model/variant": { keepRecentTokens: 4096, customPolicy: "preserved" },
						"test/other": { reserveTokens: 32768 },
					},
				},
				retry: { enabled: false, maxRetries: 4, customPolicy: true },
			}),
		);
		await owner.updatePiSettings({
			type: "compactionModel",
			provider: "test",
			modelId: "model/variant",
			override: { reserveTokens: 16384 },
		});
		await Promise.all([
			owner.updatePiSettings({ type: "cacheWarming", mode: "off" }),
			owner.getPiSettings(),
			owner.updatePiSettings({ type: "compactionTokens", field: "reserveTokens", tokens: 8192 }),
			owner.getPiSettings(),
		]);
		await owner.updatePiSettings({ type: "retryTuning", field: "maxAgentDelayMs", value: 12345 });
		expect(await owner.getPiSettings()).toMatchObject({
			cacheWarming: "off",
			retryMaxAgentDelayMs: 12345,
			compactionModelOverrides: {
				"test/model/variant": { reserveTokens: 16384, keepRecentTokens: 4096 },
				"test/other": { reserveTokens: 32768 },
			},
		});
		await owner.updatePiSettings({
			type: "compactionModel",
			provider: "test",
			modelId: "model/variant",
			override: null,
		});
		expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
			customSetting: "preserved",
			cacheWarming: "off",
			compaction: {
				reserveTokens: 8192,
				enabled: false,
				customPolicy: true,
				modelOverrides: {
					"test/model/variant": { customPolicy: "preserved" },
					"test/other": { reserveTokens: 32768 },
				},
			},
			retry: { enabled: false, maxRetries: 4, customPolicy: true, maxAgentDelayMs: 12345 },
		});
		expect((await owner.getPiSettings()).compactionModelOverrides["test/model/variant"]).toEqual({});
		const corrupt = JSON.stringify({ compaction: { modelOverrides: { "test/model/variant": 42 } } });
		await writeFile(path, corrupt);
		await expect(
			owner.updatePiSettings({ type: "compactionModel", provider: "test", modelId: "model/variant", override: null }),
		).rejects.toThrow();
		expect(await readFile(path, "utf8")).toBe(corrupt);
	} finally {
		await owner.dispose();
		await rm(agentDir, { recursive: true, force: true });
	}
});

it("preserves raw project expressions and unknown fields while rejecting stale configuration writes", async () => {
	const root = await temporaryDirectory("scoped-pi-settings");
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	await mkdir(agentDir);
	await mkdir(join(cwd, ".pi"), { recursive: true });
	const owner = createPiSettings(agentDir);
	try {
		await writeFile(
			join(agentDir, "settings.json"),
			JSON.stringify({
				defaultTools: ["read", "bash"],
				cacheWarming: "off",
				compaction: { reserveTokens: 400000 },
				providerExtension: { enabled: true },
			}),
		);
		await writeFile(
			join(cwd, ".pi", "settings.json"),
			JSON.stringify({
				defaultTools: ["+find", "-bash"],
				compaction: { keepRecentTokens: 123456 },
				providerExtension: { secretName: "fixture" },
			}),
		);
		const initial = await owner.configuration.read(cwd, true);
		expect(initial.configured.defaultTools).toEqual(["+find", "-bash"]);
		expect(initial.resolved.defaultTools).toEqual(["read", "find"]);
		expect(initial.resolved.compaction).toMatchObject({ reserveTokens: 400000, keepRecentTokens: 123456 });
		const settings = { ...initial.configured, steeringMode: "all" };
		await owner.configuration.write({ cwd, revision: initial.revision, settings }, true);
		await expect(owner.configuration.write({ cwd, revision: initial.revision, settings: {} }, true)).rejects.toThrow(
			"changed",
		);
		const current = await owner.configuration.read(cwd, true);
		expect(current.configured.providerExtension).toEqual({ secretName: "fixture" });
		const reset = { ...current.configured };
		delete reset.defaultTools;
		await owner.configuration.write({ cwd, revision: current.revision, settings: reset }, true);
		expect((await owner.configuration.read(cwd, true)).resolved.defaultTools).toEqual(["read", "bash"]);
		await expect(owner.configuration.write({ cwd, revision: current.revision, settings: {} }, false)).rejects.toThrow(
			"Trust",
		);
		expect((await owner.configuration.read(cwd, false)).resolved.providerExtension).toEqual({ enabled: true });
	} finally {
		await owner.dispose();
		await rm(root, { recursive: true, force: true });
	}
});

it("edits only the MCP override and resolves Pi's ordered built-in filters", async () => {
	const agentDir = await temporaryDirectory("pi-mcp-activation");
	const owner = createPiSettings(agentDir);
	const path = join(agentDir, "settings.json");
	try {
		await writeFile(
			path,
			JSON.stringify({ extensions: ["-builtin:*", "+builtin:mcp"], extensionOwned: { retained: true } }),
		);
		expect(await owner.mcpActivation.read()).toBe(true);
		expect(await owner.mcpActivation.write(false, true)).toBe(true);
		expect(await owner.mcpActivation.read()).toBe(false);
		await expect(owner.mcpActivation.write(true, true)).rejects.toThrow("changed");
		expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
			extensions: ["-builtin:*", "-builtin:mcp"],
			extensionOwned: { retained: true },
		});
		expect(await owner.mcpActivation.write(false, false)).toBe(false);
		expect(await owner.mcpActivation.write(true, false)).toBe(true);
		expect(await owner.mcpActivation.read()).toBe(true);
	} finally {
		await owner.dispose();
		await rm(agentDir, { recursive: true, force: true });
	}
});

it("migrates skill names to canonical paths and preserves unmatched choices without repeated writes", async () => {
	const root = await temporaryDirectory("pi-skill-migration");
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	const skill = join(agentDir, "skills", "probe", "SKILL.md");
	const settingsPath = join(agentDir, "settings.json");
	await mkdir(join(agentDir, "skills", "probe"), { recursive: true });
	await mkdir(cwd);
	await writeFile(skill, "---\nname: probe\ndescription: Migration fixture\n---\nFixture.");
	await writeFile(settingsPath, JSON.stringify({ lingSkills: { disabled: ["probe", "missing"] }, custom: 7 }));
	const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
	const skills = createLingSkillResources();
	const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, noExtensions: true });
	try {
		const prepare = async () =>
			skills.createLingSkillToggles(
				settings,
				agentDir,
				cwd,
				(await new DefaultPackageManager({ cwd, agentDir, settingsManager: settings }).resolve()).skills,
			);
		const install = await prepare();
		await loader.reload();
		install(loader);
		expect(loader.getSkills().skills.some((entry) => entry.name === "probe")).toBe(false);
		expect(skills.readDiscoveredSkills(loader).skills.some((entry) => entry.filePath === skill)).toBe(true);
		const saved = JSON.parse(await readFile(settingsPath, "utf8"));
		expect(saved).toMatchObject({
			skills: [`-${skill}`],
			custom: 7,
			lingSkills: { disabled: [], legacyDisabled: ["missing"] },
		});
		const compact = JSON.stringify(saved);
		await writeFile(settingsPath, compact);
		await prepare();
		expect(await readFile(settingsPath, "utf8")).toBe(compact);
	} finally {
		loader.getExtensions().runtime.invalidate("Fixture complete");
		await rm(root, { recursive: true, force: true });
	}
});
