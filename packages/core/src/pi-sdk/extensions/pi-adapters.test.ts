import { DefaultResourceLoader, discoverAndLoadExtensions, SettingsManager } from "@earendil-works/pi-coding-agent";
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
				todo: todo ? bundled.todo : null,
				permissions: { entry: bundled.permissions, enabled: permissionsEnabled },
			},
		});
	};
	const installedEntry = (name: string) => join(agentDir, "npm", "node_modules", name, "index.ts");
	return { bundled, install, prepare, installedEntry, cwd, agentDir };
}

describe("bundled Pi adapters", () => {
	it("resolves global and trusted project builtin filters independently, including wildcard disables", async () => {
		const f = await fixture();
		await mkdir(join(f.cwd, ".pi"));
		await writeFile(join(f.agentDir, "settings.json"), JSON.stringify({ extensions: ["-builtin:mcp"] }));
		await writeFile(join(f.cwd, ".pi/settings.json"), JSON.stringify({ extensions: ["-builtin:tool-search"] }));
		expect((await f.prepare(false, false, null, undefined, "enabled", true)).paths).toEqual(["builtin:codemode"]);
		expect((await f.prepare(false, false, null, undefined, "enabled", false)).paths).toEqual([
			"builtin:codemode",
			"builtin:tool-search",
		]);
		await writeFile(join(f.agentDir, "settings.json"), JSON.stringify({ extensions: ["!builtin:*"] }));
		const plan = await f.prepare(false, false, null, undefined, "enabled", true);
		expect(plan.paths).toEqual([]);
		const loader = new DefaultResourceLoader({
			cwd: f.cwd,
			agentDir: f.agentDir,
			noExtensions: true,
			extensionFactories: plan.factories,
			additionalExtensionPaths: plan.paths,
		});
		await loader.reload();
		try {
			expect(loader.getExtensions().errors).toEqual([]);
			expect(loader.getExtensions().extensions).toEqual([]);
		} finally {
			loader.getExtensions().runtime.invalidate("Fixture completed");
		}
	});

	it("loads official discovery extensions, honors Pi disables and preserves user packages", async () => {
		const f = await fixture();
		const plan = await f.prepare(false, false, null, undefined, "enabled");
		expect(plan.paths).toEqual(["builtin:codemode", "builtin:tool-search", "builtin:mcp"]);
		const loader = new DefaultResourceLoader({
			cwd: f.cwd,
			agentDir: f.agentDir,
			noExtensions: true,
			extensionFactories: plan.factories,
			additionalExtensionPaths: plan.paths,
		});
		await loader.reload();
		try {
			expect(loader.getExtensions().errors).toEqual([]);
			expect(loader.getExtensions().extensions.flatMap((extension) => [...extension.tools.keys()])).toEqual(
				expect.arrayContaining(["codemode", "tool_search"]),
			);
			expect(loader.getExtensions().extensions.some((extension) => extension.path === "builtin:mcp")).toBe(true);
		} finally {
			loader.getExtensions().runtime.invalidate("Fixture completed");
		}
		await f.install(["pi-mcp-adapter"]);
		expect((await f.prepare(false, false)).paths).toContain(f.installedEntry("pi-mcp-adapter"));
		await writeFile(
			join(f.agentDir, "settings.json"),
			JSON.stringify({ extensions: ["-builtin:mcp", "-builtin:codemode"] }),
		);
		expect((await f.prepare(false, false, null, undefined, "enabled")).paths).toEqual(["builtin:tool-search"]);
	});

	it("lets an installed MCP command replace the official factory without changing user settings", async () => {
		const f = await fixture();
		await f.install(["pi-mcp-adapter"]);
		await writeFile(
			f.installedEntry("pi-mcp-adapter"),
			'export default function(pi) { pi.registerCommand("mcp", { description: "Installed MCP", handler: async () => {} }); }',
		);
		for (const enabled of [true, false]) {
			const plan = await f.prepare(false, false, null, undefined, enabled ? "enabled" : null);
			const loader = new DefaultResourceLoader({
				cwd: f.cwd,
				agentDir: f.agentDir,
				noExtensions: true,
				extensionFactories: plan.factories,
				additionalExtensionPaths: plan.paths,
			});
			await loader.reload();
			try {
				const loaded = loader.getExtensions();
				expect(loaded.errors).toEqual([]);
				plan.overrides(loaded);
				expect(loaded.extensions.some((extension) => extension.path === "builtin:mcp")).toBe(false);
				expect(loaded.extensions.find((extension) => extension.commands.has("mcp"))?.path).toBe(
					f.installedEntry("pi-mcp-adapter"),
				);
			} finally {
				loader.getExtensions().runtime.invalidate("Fixture completed");
			}
		}
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
		expect((await f.prepare(false, false, voice)).paths.filter((path) => !path.startsWith("builtin:"))).toEqual([
			voice,
		]);
		await f.install(["@earendil-works/pi-voice"]);
		const installed = f.installedEntry("@earendil-works/pi-voice");
		expect((await f.prepare(false, false, voice)).paths.filter((path) => !path.startsWith("builtin:"))).toEqual([
			installed,
		]);
		expect((await f.prepare(false, false)).paths.filter((path) => !path.startsWith("builtin:"))).toEqual([installed]);
	});
	it("loads the bundled todo and loads the bundled permission system only where it is enabled", async () => {
		const f = await fixture();
		const full = await f.prepare(false);
		expect(full.paths.filter((path) => !path.startsWith("builtin:"))).toEqual([f.bundled.todo]);
		expect([...full.bundledPaths]).toEqual([f.bundled.todo]);
		expect((await f.prepare(false, false)).paths.filter((path) => !path.startsWith("builtin:"))).toEqual([]);
		const approval = await f.prepare(true);
		expect(approval.paths.filter((path) => !path.startsWith("builtin:")).sort()).toEqual(
			[f.bundled.permissions, f.bundled.todo].sort(),
		);
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
		expect(full.paths.filter((path) => !path.startsWith("builtin:"))).toEqual([
			f.installedEntry("@juicesharp/rpiv-todo"),
		]);
		expect((await f.prepare(false, false)).paths.filter((path) => !path.startsWith("builtin:"))).toEqual([
			f.installedEntry("@juicesharp/rpiv-todo"),
		]);
	});
});
