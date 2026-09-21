import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { temporaryDirectory } from "../../../../../test/temporary-directory";
import { createPiSettings } from "./settings";

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
