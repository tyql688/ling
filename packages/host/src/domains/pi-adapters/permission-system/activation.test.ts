import { afterEach, expect, it } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { temporaryDirectory } from "../../../../../../test/temporary-directory";
import { createAccessActivation } from "./activation";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
	const home = await temporaryDirectory("pi-activation");
	roots.push(home);
	return { home, owner: createAccessActivation(home), signal: new AbortController().signal };
}
it("retains independent project overrides across global changes and process restarts without editing Pi rules", async () => {
	const f = await fixture();
	const cwd = join(f.home, "project");
	const rule = join(cwd, ".pi", "extensions", "pi-permission-system", "config.json");
	await mkdir(join(rule, ".."), { recursive: true });
	const source = '{"permission":{"write":"deny"},"yoloMode":false}';
	await writeFile(rule, source);
	expect(await f.owner.read()).toEqual({ revision: 0, defaultEnabled: false, projects: {} });
	const projectChange = await f.owner.write({ expectedRevision: 0, project: { cwd, enabled: false } }, f.signal);
	expect(projectChange.previous).toEqual({ revision: 0, defaultEnabled: false, projects: {} });
	expect(projectChange.current.projects).toEqual({ [cwd]: false });
	const globalChange = await f.owner.write({ expectedRevision: 1, defaultEnabled: true }, f.signal);
	expect(globalChange.previous.defaultEnabled).toBe(false);
	expect(globalChange.current.defaultEnabled).toBe(true);
	expect(globalChange.current.projects[cwd]).toBe(false);
	expect(await createAccessActivation(f.home).read()).toEqual({
		revision: 2,
		defaultEnabled: true,
		projects: { [cwd]: false },
	});
	await f.owner.write({ expectedRevision: 2, project: { cwd, enabled: null } }, f.signal);
	expect(await f.owner.read()).toEqual({ revision: 3, defaultEnabled: true, projects: {} });
	expect(await readFile(rule, "utf8")).toBe(source);
});
it("serializes competing writers and preserves the winning value after stale or cancelled updates", async () => {
	const f = await fixture();
	const other = createAccessActivation(f.home);
	const results = await Promise.allSettled([
		f.owner.write({ expectedRevision: 0, defaultEnabled: true }, f.signal),
		other.write({ expectedRevision: 0, defaultEnabled: false }, f.signal),
	]);
	expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
	const saved = await f.owner.read();
	await expect(
		f.owner.write({ expectedRevision: saved.revision, defaultEnabled: !saved.defaultEnabled }, AbortSignal.abort()),
	).rejects.toThrow();
	expect(await other.read()).toEqual(saved);
});
it("does not turn unreadable saved activation into the full-access default", async () => {
	const f = await fixture();
	await f.owner.write({ expectedRevision: 0, defaultEnabled: true }, f.signal);
	const path = join(f.home, "plugin-data", "ling-permission-system", "pi-activation.json");
	await writeFile(path, "{broken");
	await expect(f.owner.read()).rejects.toThrow();
	await expect(f.owner.write({ expectedRevision: 1, defaultEnabled: false }, f.signal)).rejects.toThrow();
	expect(await readFile(path, "utf8")).toBe("{broken");
});
