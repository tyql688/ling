import { describe, expect, it, vi } from "vitest";
import { PI_DEFAULT_TOOL_NAMES, type PiSettingsSnapshot, type PiSettingsUpdate } from "@ling/contracts/pi-settings";
import { createPiSettingsMutations } from "./pi-settings-mutations";

function settings(): PiSettingsSnapshot {
	return {
		defaultProvider: null,
		defaultModel: null,
		defaultThinkingLevel: null,
		compactionEnabled: true,
		compactionReserveTokens: 16000,
		compactionKeepRecentTokens: 20000,
		compactionModelOverrides: {},
		cacheWarming: "off",
		retryEnabled: true,
		retryMaxRetries: 3,
		retryBaseDelayMs: 2000,
		retryMaxAgentDelayMs: 60000,
		blockImages: false,
		imageAutoResize: true,
		shellCommandPrefix: null,
		defaultProjectTrust: "ask",
		steeringMode: "one-at-a-time",
		followUpMode: "one-at-a-time",
		shellPath: null,
		npmCommand: null,
		installTelemetry: false,
		analytics: false,
		httpIdleTimeoutMs: 300000,
		enableSkillCommands: true,
		defaultTools: [...PI_DEFAULT_TOOL_NAMES],
		defaultToolsConfigured: false,
		codemode: { mode: "on", inlineBudget: 3000 },
	};
}

const toggle =
	(tool: string) =>
	(current: PiSettingsSnapshot): PiSettingsUpdate => ({
		type: "defaultTools",
		tools: current.defaultTools.includes(tool)
			? current.defaultTools.filter((name) => name !== tool)
			: [...current.defaultTools, tool],
	});

describe("Pi settings pending choices", () => {
	it("acknowledges independent choices immediately, gates duplicates and preserves them across earlier replies", async () => {
		let saved = settings();
		const firstWrite = Promise.withResolvers<void>();
		const secondWrite = Promise.withResolvers<void>();
		const update = vi.fn(async (value: PiSettingsUpdate) => {
			await (update.mock.calls.length === 1 ? firstWrite.promise : secondWrite.promise);
			if (value.type !== "defaultTools") throw new Error("Unexpected update");
			saved = { ...saved, defaultTools: value.tools ?? [...PI_DEFAULT_TOOL_NAMES], defaultToolsConfigured: true };
			return saved;
		});
		const owner = createPiSettingsMutations({ get: async () => saved, update });
		owner.replace(saved);
		const first = owner.apply(toggle("find"), "defaultTools:find");
		const second = owner.apply(toggle("grep"), "defaultTools:grep");
		expect(owner.apply(toggle("find"), "defaultTools:find")).toBe(first);
		expect(owner.getSnapshot().snapshot?.defaultTools).toEqual([...PI_DEFAULT_TOOL_NAMES, "find", "grep"]);
		expect(owner.getSnapshot().pending).toEqual(new Set(["defaultTools:find", "defaultTools:grep"]));
		firstWrite.resolve();
		await first;
		expect(owner.getSnapshot().snapshot?.defaultTools).toEqual([...PI_DEFAULT_TOOL_NAMES, "find", "grep"]);
		expect(owner.getSnapshot().pending).toEqual(new Set(["defaultTools:grep"]));
		secondWrite.resolve();
		await second;
		expect(update).toHaveBeenCalledTimes(2);
		expect(saved.defaultTools).toEqual([...PI_DEFAULT_TOOL_NAMES, "find", "grep"]);
		expect(owner.getSnapshot().pending.size).toBe(0);
	});

	it("rolls back a failed choice without dropping a queued choice or hiding the failure after an unrelated success", async () => {
		let saved = settings();
		const rejected = new Error("Settings cannot be saved");
		const release = Promise.withResolvers<void>();
		const update = vi.fn(async (value: PiSettingsUpdate) => {
			if (update.mock.calls.length === 1) throw rejected;
			await release.promise;
			if (value.type !== "defaultTools") throw new Error("Unexpected update");
			saved = { ...saved, defaultTools: value.tools ?? [...PI_DEFAULT_TOOL_NAMES] };
			return saved;
		});
		const owner = createPiSettingsMutations({ get: async () => saved, update });
		owner.replace(saved);
		const first = owner.apply(toggle("find"), "defaultTools:find");
		const second = owner.apply(toggle("grep"), "defaultTools:grep");
		expect(await first).toBe(false);
		expect(owner.getSnapshot().snapshot?.defaultTools).toEqual([...PI_DEFAULT_TOOL_NAMES, "grep"]);
		release.resolve();
		expect(await second).toBe(true);
		expect(saved.defaultTools).toEqual([...PI_DEFAULT_TOOL_NAMES, "grep"]);
		expect(owner.getSnapshot().error).toEqual({ key: "defaultTools:find", cause: rejected });
		await owner.apply(toggle("find"), "defaultTools:find");
		expect(owner.getSnapshot().error).toBeNull();
	});

	it("adopts settings persisted before a reload failure and retains the authoritative state when recovery reads fail", async () => {
		let saved = settings();
		const failure = new Error("Reload failed");
		const get = vi.fn(async () => saved);
		const owner = createPiSettingsMutations({
			get,
			update: async () => {
				saved = { ...saved, codemode: { ...saved.codemode, mode: "only" } };
				throw failure;
			},
		});
		owner.replace(saved);
		expect(await owner.apply({ type: "codemode", settings: { mode: "only" } })).toBe(false);
		expect(owner.getSnapshot().snapshot?.codemode.mode).toBe("only");
		get.mockRejectedValueOnce(new Error("Read failed"));
		const failed = owner.apply({ type: "codemode", settings: { mode: "on" } });
		expect(owner.getSnapshot().snapshot?.codemode.mode).toBe("on");
		expect(await failed).toBe(false);
		expect(owner.getSnapshot().snapshot?.codemode.mode).toBe("only");
		expect(owner.getSnapshot().error?.cause).toBe(failure);
	});

	it("preserves external tool edits by resolving the mutation against freshly saved settings", async () => {
		let saved = settings();
		const update = vi.fn(async (value: PiSettingsUpdate) => {
			if (value.type !== "defaultTools") throw new Error("Unexpected update");
			return { ...saved, defaultTools: value.tools ?? [...PI_DEFAULT_TOOL_NAMES] };
		});
		const owner = createPiSettingsMutations({ get: async () => saved, update });
		owner.replace(saved);
		saved = { ...saved, defaultTools: [...saved.defaultTools, "external_tool"] };
		await owner.apply(toggle("find"), "defaultTools:find");
		expect(owner.getSnapshot().snapshot?.defaultTools).toEqual([...PI_DEFAULT_TOOL_NAMES, "external_tool", "find"]);
	});

	it("keeps Codemode mode and budget writes independent", async () => {
		let saved = settings();
		const release = Promise.withResolvers<void>();
		const update = vi.fn(async (value: PiSettingsUpdate) => {
			await release.promise;
			if (value.type !== "codemode") throw new Error("Unexpected update");
			saved = {
				...saved,
				codemode: {
					mode: value.settings.mode ?? saved.codemode.mode,
					inlineBudget: value.settings.inlineBudget ?? saved.codemode.inlineBudget,
				},
			};
			return saved;
		});
		const owner = createPiSettingsMutations({ get: async () => saved, update });
		owner.replace(saved);
		const mode = owner.apply({ type: "codemode", settings: { mode: "only" } });
		const budget = owner.apply({ type: "codemode", settings: { inlineBudget: 0 } });
		expect(owner.getSnapshot().snapshot?.codemode.mode).toBe("only");
		release.resolve();
		await Promise.all([mode, budget]);
		expect(saved.codemode).toEqual({ mode: "only", inlineBudget: 0 });
		expect(update).toHaveBeenCalledTimes(2);
	});

	it("fences late results from a previous view owner and drains admitted writes", async () => {
		const saved = settings();
		const release = Promise.withResolvers<PiSettingsSnapshot>();
		const owner = createPiSettingsMutations({ get: async () => saved, update: () => release.promise });
		owner.replace(saved);
		const pending = owner.apply({ type: "defaultTools", tools: [] });
		expect(owner.getSnapshot().snapshot?.defaultTools).toEqual([]);
		owner.invalidate();
		release.resolve({ ...saved, defaultTools: [] });
		await owner.whenSettled();
		expect(await pending).toBe(true);
		expect(owner.getSnapshot().snapshot).toEqual(saved);
		expect(owner.getSnapshot().pending.size).toBe(0);
	});

	it("recovers an initially unreadable snapshot even when applying the repair reports a reload failure", async () => {
		const saved = settings();
		const failure = new Error("Saved repair could not reload");
		const owner = createPiSettingsMutations({ get: async () => saved, update: async () => saved });
		expect(
			await owner.repair(async () => {
				throw failure;
			}),
		).toBe(false);
		expect(owner.getSnapshot().snapshot).toEqual(saved);
		expect(owner.getSnapshot().error?.cause).toBe(failure);
	});
});
