import { discoverAndLoadExtensions, SettingsManager } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
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
	const prepare = async (
		permissionsEnabled: boolean,
		todo = true,
		voice: string | null = null,
		openVoiceSettings?: Parameters<typeof preparePiAdapters>[0]["openVoiceSettings"],
		mcp: string | null = null,
		trusted = false,
	) => {
		const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: trusted });
		await settingsManager.reload();
		return preparePiAdapters({
			cwd,
			agentDir,
			settingsManager,
			...(openVoiceSettings ? { openVoiceSettings } : {}),
			plan: {
				features: {
					todo,
					permissions: true,
					questions: true,
					"background-tasks": true,
					schedules: true,
					voice: voice !== null,
					mcp: mcp !== null,
				},
				voice,
				mcp,
				todo: todo ? bundled.todo : null,
				permissions: { entry: bundled.permissions, enabled: permissionsEnabled },
			},
		});
	};
	const installedEntry = (name: string) => join(agentDir, "npm", "node_modules", name, "index.ts");
	return { bundled, install, prepare, installedEntry, cwd, agentDir };
}

describe("bundled Pi adapters", () => {
	it("loads bundled MCP only in trusted projects and respects user-installed precedence", async () => {
		const f = await fixture();
		const entry = join(f.cwd, "bundled-mcp.ts");
		expect((await f.prepare(false, false, null, undefined, entry)).paths).not.toContain(entry);
		expect((await f.prepare(false, false, null, undefined, entry, true)).paths).toContain(entry);
		await f.install(["pi-mcp-adapter"]);
		const installed = f.installedEntry("pi-mcp-adapter");
		expect((await f.prepare(false, false, null, undefined, entry, true)).paths).toEqual([installed]);
		expect((await f.prepare(false, false, null, undefined, null, true)).paths).toEqual([installed]);
		expect((await f.prepare(false, false, null, undefined, entry, false)).paths).toEqual([]);
	});

	it("replaces voice terminal onboarding while preserving the published file tool and shutdown", async () => {
		const f = await fixture();
		const entry = fileURLToPath(
			new URL("../../../../host/node_modules/@earendil-works/pi-voice/index.ts", import.meta.url),
		);
		const loaded = await discoverAndLoadExtensions([entry], f.cwd, f.agentDir);
		expect(loaded.errors).toEqual([]);
		const voice = loaded.extensions[0]!;
		const fileTool = voice.tools.get("transcribe_file");
		const shutdown = voice.handlers.get("session_shutdown");
		expect(fileTool).toBeDefined();
		expect(shutdown).toHaveLength(1);
		expect(voice.handlers.get("session_start")).toHaveLength(1);
		const settings = voice.commands.get("voice-settings")!.handler;
		const adapter = await f.prepare(false, false, entry, () => {});
		adapter.overrides(loaded);
		expect(voice.handlers.has("session_start")).toBe(false);
		expect(voice.shortcuts.size).toBe(0);
		expect(voice.commands.get("voice-settings")!.handler).not.toBe(settings);
		expect(voice.tools.get("transcribe_file")).toBe(fileTool);
		expect(voice.handlers.get("session_shutdown")).toBe(shutdown);
	}, 30_000);
	it("prefers the user's voice package and preserves it when Ling voice is disabled", async () => {
		const f = await fixture();
		const voice = join(f.bundled.todo, "..", "voice.ts");
		expect((await f.prepare(false, false, voice)).paths).toEqual([voice]);
		await f.install(["@earendil-works/pi-voice"]);
		const installed = f.installedEntry("@earendil-works/pi-voice");
		expect((await f.prepare(false, false, voice)).paths).toEqual([installed]);
		expect((await f.prepare(false, false)).paths).toEqual([installed]);
	});
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
