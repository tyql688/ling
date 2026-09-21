import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { temporaryDirectory } from "../../../../../test/temporary-directory";
import { createBuiltinFeatures } from "./builtin-features";

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
	});
	await f.owner.write({ id: "questions", enabled: false, expectedRevision: 0 }, f.signal);
	expect((await createBuiltinFeatures(f.home).read()).enabled.questions).toBe(false);
	expect(await readFile(legacy, "utf8")).toBe(text);
});

it("rejects stale writes and cannot turn a disabled feature into an empty success", async () => {
	const f = await fixture();
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

it("surfaces corrupt old and new settings instead of enabling features by default", async () => {
	const f = await fixture();
	await writeFile(join(f.home, "plugin-state", "plugins.json"), "{broken");
	await expect(f.owner.read()).rejects.toThrow();
	await writeFile(join(f.home, "plugin-state", "builtin-features.json"), "{}");
	await expect(f.owner.read()).rejects.toThrow();
});
