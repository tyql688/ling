import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { temporaryDirectory } from "../../../../../test/temporary-directory";
import { preparePiAdapters } from "./pi-adapters";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
	const root = await temporaryDirectory("pi-adapters");
	roots.push(root);
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	await mkdir(cwd);
	await mkdir(agentDir);
	const bundled = { todo: join(root, "bundled", "todo.ts"), permissions: join(root, "bundled", "permissions.ts") };
	await mkdir(join(root, "bundled"));
	for (const path of Object.values(bundled)) await writeFile(path, "export default function () {}");
	/** Places a package where Pi keeps user-scope npm installs and lists it in the agent settings. */
	const install = async (names: string[]) => {
		for (const name of names) {
			const directory = join(agentDir, "npm", "node_modules", name);
			await mkdir(directory, { recursive: true });
			await writeFile(
				join(directory, "package.json"),
				JSON.stringify({ name, version: "9.9.9", pi: { extensions: ["./index.ts"] } }),
			);
			await writeFile(join(directory, "index.ts"), "export default function () {}");
		}
		await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: names.map((name) => `npm:${name}`) }));
	};
	const prepare = async (permissionsEnabled: boolean, todo = true) => {
		const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
		await settingsManager.reload();
		return preparePiAdapters({
			cwd,
			agentDir,
			settingsManager,
			plan: {
				features: { todo, permissions: true, questions: true, "background-tasks": true, schedules: true },
				todo: todo ? bundled.todo : null,
				permissions: { entry: bundled.permissions, enabled: permissionsEnabled },
			},
		});
	};
	const installedEntry = (name: string) => join(agentDir, "npm", "node_modules", name, "index.ts");
	return { bundled, install, prepare, installedEntry };
}

describe("bundled Pi adapters", () => {
	it("loads the bundled todo and loads the bundled permission system only where it is enabled", async () => {
		const f = await fixture();
		const full = await f.prepare(false);
		expect(full.paths).toEqual([f.bundled.todo]);
		expect([...full.bundledPaths]).toEqual([f.bundled.todo]);
		expect((await f.prepare(false, false)).paths).toEqual([]);
		const approval = await f.prepare(true);
		expect(approval.paths.sort()).toEqual([f.bundled.permissions, f.bundled.todo].sort());
	});

	it("lets a package the user installed through Pi replace the bundled copy", async () => {
		const f = await fixture();
		await f.install(["@juicesharp/rpiv-todo", "@gotgenes/pi-permission-system"]);
		const approval = await f.prepare(true);
		expect(approval.paths).toContain(f.installedEntry("@juicesharp/rpiv-todo"));
		expect(approval.paths).toContain(f.installedEntry("@gotgenes/pi-permission-system"));
		expect(approval.paths).not.toContain(f.bundled.todo);
		expect(approval.paths).not.toContain(f.bundled.permissions);
		expect(approval.bundledPaths.size).toBe(0);
		// Full access removes the user's own copy of the permission system too, and nothing else.
		const full = await f.prepare(false);
		expect(full.paths).toEqual([f.installedEntry("@juicesharp/rpiv-todo")]);
		expect((await f.prepare(false, false)).paths).toEqual([f.installedEntry("@juicesharp/rpiv-todo")]);
	});
});
