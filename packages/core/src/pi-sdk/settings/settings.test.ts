import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { temporaryDirectory } from "../../../../../test/temporary-directory";
import { createPiSettings } from "./settings";
import { createPiSkillCatalog } from "../resources/skills";
import { createLingSkillResources } from "../resources/skill-toggles";

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
