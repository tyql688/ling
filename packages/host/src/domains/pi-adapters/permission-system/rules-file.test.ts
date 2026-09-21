import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { temporaryDirectory } from "../../../../../../test/temporary-directory";
import { prepareRulesFile } from "./rules-file";

const roots: string[] = [];
async function fixture() {
	const root = await temporaryDirectory("permission-rules");
	roots.push(root);
	return root;
}
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("permission rule file entry", () => {
	it("creates neutral files in the isolated Pi directory and the explicitly selected project", async () => {
		const root = await fixture();
		const agent = join(root, "pi");
		vi.stubEnv("PI_CODING_AGENT_DIR", `~/${relative(homedir(), agent)}`);
		const project = join(root, "project");
		await mkdir(project);
		const global = await prepareRulesFile(null);
		const local = await prepareRulesFile(project);
		expect(global).toBe(join(agent, "extensions/pi-permission-system/config.json"));
		expect(local).toBe(join(project, ".pi/extensions/pi-permission-system/config.json"));
		expect(await readFile(global, "utf8")).toBe("{}\n");
		expect(await readFile(local, "utf8")).toBe("{}\n");
	});

	it("preserves existing content and comments even when it needs repair, including repeated opens", async () => {
		const root = await fixture();
		const path = join(root, ".pi/extensions/pi-permission-system/config.json");
		await mkdir(dirname(path), { recursive: true });
		const content = '// Keep my rules, including this unfinished edit.\n{"permission": {"write": "deny"},';
		await writeFile(path, content);
		expect(await Promise.all([prepareRulesFile(root), prepareRulesFile(root)])).toEqual([path, path]);
		expect(await readFile(path, "utf8")).toBe(content);
	});

	it("does not recreate missing projects or replace a broken configuration path", async () => {
		const root = await fixture();
		await expect(prepareRulesFile(join(root, "missing-project"))).rejects.toMatchObject({ code: "ENOENT" });
		const path = join(root, ".pi/extensions/pi-permission-system/config.json");
		await mkdir(path, { recursive: true });
		await expect(prepareRulesFile(root)).rejects.toThrow("not a file");
		await rm(path, { recursive: true });
		await symlink(join(root, "missing-file"), path);
		await expect(prepareRulesFile(root)).rejects.toMatchObject({ code: "ENOENT" });
	});
});
