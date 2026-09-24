import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { temporaryDirectory } from "../../../../../test/temporary-directory";
import { createBuiltinFeatures } from "./builtin-features";
import { changeBuiltinFeature } from "./builtin-feature-change";
import { createResourceReloadCoordinator } from "../resources/resource-reload";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});
async function fixture() {
	const home = await temporaryDirectory("builtin-features");
	roots.push(home);
	await mkdir(join(home, "plugin-state"));
	return { home, owner: createBuiltinFeatures(home), signal: new AbortController().signal };
}

it("retains old disabled built-ins without altering retired plugin data or unknown plugins", async () => {
	const f = await fixture();
	const legacy = join(f.home, "plugin-state", "plugins.json");
	const text = JSON.stringify({
		version: 1,
		enabled: ["my-plugin"],
		disabled: ["ling-todo", "ling-schedules", "custom"],
		selections: {},
	});
	await writeFile(legacy, text);
	expect((await f.owner.read()).enabled).toEqual({
		todo: false,
		permissions: true,
		questions: true,
		"background-tasks": true,
		schedules: false,
		voice: false,
		mcp: false,
	});
	await f.owner.write({ id: "questions", enabled: false, expectedRevision: 0 }, f.signal);
	expect((await createBuiltinFeatures(f.home).read()).enabled.questions).toBe(false);
	expect(await readFile(legacy, "utf8")).toBe(text);
});

it("rejects stale writes and cannot turn a disabled feature into an empty success", async () => {
	const f = await fixture();
	expect((await f.owner.read()).enabled.voice).toBe(false);
	const second = createBuiltinFeatures(f.home);
	await f.owner.write({ id: "schedules", enabled: false, expectedRevision: 0 }, f.signal);
	await expect(second.write({ id: "todo", enabled: false, expectedRevision: 0 }, f.signal)).rejects.toThrow("changed");
	await expect(second.requireEnabled("schedules")).rejects.toMatchObject({
		lingError: { code: "BUILTIN_FEATURE_DISABLED" },
	});
	expect((await second.read()).enabled.todo).toBe(true);
	await second.write({ id: "schedules", enabled: true, expectedRevision: 1 }, f.signal);
	expect((await f.owner.read()).schedulesResumedAt).toBeGreaterThan(0);
	await expect(f.owner.requireEnabled("schedules")).resolves.toBeUndefined();
});

it("leaves unchanged switches untouched without publishing events or reloading resources", async () => {
	const f = await fixture();
	const input = { id: "voice", enabled: false, expectedRevision: 0 } as const;
	const reloadProjectSettings = vi.fn(async () => {});
	const resources = createResourceReloadCoordinator({
		reloadProjectSettings,
		reloadSessionResources: async () => ({ revision: 0, reloaded: 0, deferred: 0, failed: [], failedOmitted: 0 }),
	});
	const onChanged = vi.fn();
	try {
		expect(await f.owner.write(input, f.signal)).toBe(false);
		await changeBuiltinFeature({ features: f.owner, resources, onChanged }, input, f.signal);
		expect(reloadProjectSettings).not.toHaveBeenCalled();
		expect(onChanged).not.toHaveBeenCalled();
		const path = join(f.home, "plugin-state", "builtin-features.json");
		await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await f.owner.write({ ...input, enabled: true }, f.signal)).toBe(true);
		const saved = `${JSON.stringify(await f.owner.read())}\n`;
		await writeFile(path, saved);
		await changeBuiltinFeature(
			{ features: f.owner, resources, onChanged },
			{ ...input, enabled: true, expectedRevision: 1 },
			f.signal,
		);
		expect(await readFile(path, "utf8")).toBe(saved);
		expect(reloadProjectSettings).not.toHaveBeenCalled();
		await expect(f.owner.write(input, f.signal)).rejects.toThrow("changed");
	} finally {
		await resources.dispose();
	}
});

it("adds voice to existing feature settings while preserving disabled choices and revisions", async () => {
	const f = await fixture();
	const path = join(f.home, "plugin-state", "builtin-features.json");
	const old = {
		revision: 7,
		enabled: { todo: false, permissions: true, questions: false, "background-tasks": true, schedules: false },
		schedulesResumedAt: 123,
	};
	await writeFile(path, JSON.stringify(old));
	const value = await f.owner.read();
	expect(value).toEqual({ ...old, enabled: { ...old.enabled, voice: false, mcp: false } });
	await f.owner.write({ id: "voice", enabled: true, expectedRevision: 7 }, f.signal);
	expect(await createBuiltinFeatures(f.home).read()).toEqual({
		...old,
		revision: 8,
		enabled: { ...old.enabled, voice: true, mcp: false },
	});
	await writeFile(path, JSON.stringify({ ...old, enabled: { ...old.enabled, voice: null } }));
	await expect(createBuiltinFeatures(f.home).read()).rejects.toThrow();
});

it("surfaces corrupt old and new settings instead of enabling features by default", async () => {
	const f = await fixture();
	await writeFile(join(f.home, "plugin-state", "plugins.json"), "{broken");
	await expect(f.owner.read()).rejects.toThrow();
	await writeFile(join(f.home, "plugin-state", "builtin-features.json"), "{}");
	await expect(f.owner.read()).rejects.toThrow();
});
