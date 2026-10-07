import {
	DefaultPackageManager,
	DefaultResourceLoader,
	discoverAndLoadExtensions,
	SettingsManager,
	SessionManager,
	createAgentSession,
	createBashToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { temporaryDirectory } from "../../../../../test/temporary-directory";
import { preparePiAdapters, createPiBuiltinExtensionFactories } from "./pi-adapters";
import { createPiToolRendererProjection, hasPiToolRenderers } from "./extension-tool-renderer";
import { projectPiBranchMessages, projectPiToolResult } from "../session/session-message-projector";
import { piBranchProjectionSource } from "../types";
import { createPiExtensionUi } from "./extension-ui-context";
import { createExtensionUiBridge } from "../../pi-protocol/extension-ui";

const roots: string[] = [];
afterEach(async () => {
	vi.unstubAllEnvs();
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
		const input = {
			sessionRuntime: true,
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
		};
		const adapters = await preparePiAdapters(input);
		const inventory = await new DefaultPackageManager({
			cwd,
			agentDir,
			settingsManager,
			builtinExtensions: ["codemode", "tool-search", "mcp"],
		}).resolve();
		return {
			...adapters,
			input,
			factories: createPiBuiltinExtensionFactories({ cwd, agentDir, settingsManager }),
			settingsManager,
			paths: [
				...inventory.extensions.filter((entry) => entry.enabled).map((entry) => entry.path),
				...adapters.bundledPaths,
			],
		};
	};
	const installedEntry = (name: string) => join(agentDir, "npm", "node_modules", name, "index.ts");
	return { bundled, install, prepare, installedEntry, cwd, agentDir };
}

describe("bundled Pi adapters", () => {
	it("keeps wrapped Bash approval rules scoped to their command", async () => {
		const f = await fixture();
		vi.stubEnv("PI_CODING_AGENT_DIR", f.agentDir);
		const require = createRequire(new URL("../../../../host/package.json", import.meta.url));
		const entry = join(require.resolve("@gotgenes/pi-permission-system"), "..", "index.ts");
		const config = join(f.agentDir, "extensions", "pi-permission-system");
		await mkdir(config, { recursive: true });
		await writeFile(join(f.cwd, "ask.txt"), "Fixture");
		await writeFile(join(f.cwd, "deny.txt"), "Fixture");
		await writeFile(
			join(config, "config.json"),
			JSON.stringify({
				permission: {
					"*": "allow",
					bash: {
						"*": "allow",
						"printf NEEDS_APPROVAL": "ask",
						[`cat ${join(f.cwd, "ask.txt")}`]: "ask",
						[`cat ${join(f.cwd, "deny.txt")}`]: "deny",
					},
				},
			}),
		);
		const resourceLoader = new DefaultResourceLoader({
			cwd: f.cwd,
			agentDir: f.agentDir,
			additionalExtensionPaths: [entry],
		});
		await resourceLoader.reload();
		expect(resourceLoader.getExtensions().errors).toEqual([]);
		const { session } = await createAgentSession({
			cwd: f.cwd,
			agentDir: f.agentDir,
			resourceLoader,
			sessionManager: SessionManager.inMemory(f.cwd),
		});
		const bridge = createExtensionUiBridge();
		const ui = createPiExtensionUi(bridge);
		const prompts: string[] = [];
		let decision = "No";
		try {
			await session.bindExtensions({
				uiContext: {
					...ui.createPiExtensionUiContext({ cwd: f.cwd, sessionId: session.sessionId }),
					select: async (title, options) => {
						prompts.push(title);
						const selected = options.find((option) => option.startsWith(decision));
						expect(selected).toBeDefined();
						return selected;
					},
				},
			});
			for (const prefix of [
				"",
				"time -p ",
				"timeout 3 ",
				"nice -n 5 ",
				"stdbuf -oL ",
				"setsid ",
				"timeout 3 nice -n 5 ",
			]) {
				const before = prompts.length;
				for (const file of ["ask.txt", "deny.txt"]) {
					const result = await session.extensionRunner.emitToolCall({
						type: "tool_call",
						toolName: "bash",
						toolCallId: `${prefix}-${file}`,
						input: { command: `${prefix}cat ./${file}` },
					});
					expect(result?.block, `${prefix}${file}`).toBe(true);
				}
				expect(prompts.length, prefix).toBe(before + 1);
			}
			const granted = "sh -c 'printf GRANTED'";
			decision = "Yes, allow bash";
			const beforeGrant = prompts.length;
			const grant = await session.extensionRunner.emitToolCall({
				type: "tool_call",
				toolName: "bash",
				toolCallId: "session-grant",
				input: { command: granted },
			});
			expect(grant, JSON.stringify({ grant, prompts: prompts.slice(beforeGrant) })).not.toMatchObject({ block: true });
			expect(prompts.length).toBe(beforeGrant + 1);
			decision = "No";
			expect(
				await session.extensionRunner.emitToolCall({
					type: "tool_call",
					toolName: "bash",
					toolCallId: "session-grant-chain",
					input: { command: `${granted} && printf NEEDS_APPROVAL` },
				}),
			).toMatchObject({ block: true });
			expect(prompts.length).toBe(beforeGrant + 2);
		} finally {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
			await ui.dispose();
			bridge.dispose();
		}
	});
	it("projects unregistered tool renderers and isolates resolver failures from transcript content", async () => {
		const f = await fixture();
		const resourceLoader = new DefaultResourceLoader({
			cwd: f.cwd,
			agentDir: f.agentDir,
			noExtensions: true,
			extensionFactories: [
				{
					name: "renderer-fixture",
					factory(pi) {
						pi.registerToolRenderer((name, next) => {
							if (name === "broken") throw new Error("Fixture renderer failed");
							if (name !== "offline") return next();
							return {
								renderCall: () => ({ render: (width) => [`Offline call ${width}`], invalidate() {} }),
								renderResult: (_result, options) => ({
									render: (width) => [
										`${options.isPartial ? "Partial" : options.expanded ? "Expanded result" : "Collapsed result"} ${width}`,
									],
									invalidate() {},
								}),
							};
						});
					},
				},
			],
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: f.cwd,
			agentDir: f.agentDir,
			resourceLoader,
			sessionManager: SessionManager.inMemory(f.cwd),
		});
		try {
			await session.bindExtensions({});
			let width = 120;
			const projection = createPiToolRendererProjection(piBranchProjectionSource(session), () => width);
			expect(hasPiToolRenderers(session)).toBe(true);
			expect(session.extensionRunner.getToolDefinition("offline")).toBeUndefined();
			expect(
				projection.project({
					role: "assistant",
					content: [
						{ type: "toolCall", id: "offline-call", name: "offline", arguments: {} },
						{ type: "toolCall", id: "broken-call", name: "broken", arguments: {} },
					],
				}),
			).toMatchObject({
				content: [
					{ rendered: { columns: 120, collapsedLines: ["Offline call 120"] } },
					{ rendered: { error: "Fixture renderer failed" } },
				],
			});
			width = 60;
			expect(projection.projectPartial("offline-call", { content: [] })).toMatchObject({
				columns: 60,
				collapsedLines: ["Partial 60"],
			});
			expect(
				projection.project(
					{
						role: "toolResult",
						toolCallId: "offline-call",
						toolName: "offline",
						isError: false,
						content: [{ type: "text", text: "Retained result" }],
					},
					true,
				),
			).toMatchObject({
				content: [{ text: "Retained result" }],
				rendered: { columns: 60, collapsedLines: ["Collapsed result 60"], expandedLines: ["Expanded result 60"] },
			});
			expect(projection.projectPartial("offline-call", { content: [] })).toBeUndefined();
			session.sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "toolCall", id: "offline-call", name: "offline", arguments: {} }],
				api: "openai-responses",
				provider: "test",
				model: "test",
				stopReason: "toolUse",
				timestamp: 1,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			});
			const resultId = session.sessionManager.appendMessage({
				role: "toolResult",
				toolCallId: "offline-call",
				toolName: "offline",
				isError: false,
				content: [{ type: "text", text: "Retained result" }],
				timestamp: 2,
			});
			expect(projectPiBranchMessages(piBranchProjectionSource(session), { markdownWidth: 105 })[0]).toMatchObject({
				content: [{ rendered: { columns: 105, expandedLines: ["Offline call 105"] } }],
			});
			for (const columns of [72, 130, 72]) {
				expect(projectPiToolResult(session, resultId, columns)).toMatchObject({
					entryId: resultId,
					content: [{ text: "Retained result" }],
					renderedCall: { columns, expandedLines: [`Offline call ${columns}`] },
					rendered: { columns, expandedLines: [`Expanded result ${columns}`] },
				});
			}
		} finally {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
		}
	});
	it("requires an available permission implementation while allowing a user-installed replacement", async () => {
		const f = await fixture();
		const base = await f.prepare(false, false);
		const input = { ...base.input, plan: { ...base.input.plan, permissions: { entry: null, enabled: true } } };
		await expect(preparePiAdapters(input)).rejects.toMatchObject({
			code: "PI_PERMISSION_UNAVAILABLE",
			message: expect.stringContaining("package is unavailable"),
		});
		await expect(preparePiAdapters({ ...input, sessionRuntime: false })).resolves.toMatchObject({
			bundledPaths: new Set(),
		});
		await f.install(["@gotgenes/pi-permission-system"]);
		await input.settingsManager.reload();
		const installed = await preparePiAdapters(input);
		expect(installed.bundledPaths.size).toBe(0);
		const loaded = await discoverAndLoadExtensions([], f.cwd, f.agentDir);
		try {
			expect(() => installed.overrides(loaded)).toThrow("no active Pi permission extension");
		} finally {
			loaded.runtime.invalidate("Fixture completed");
		}
	});

	it("gates Host background commands through the installed permission package's Bash and path policies", async () => {
		const f = await fixture();
		vi.stubEnv("PI_CODING_AGENT_DIR", f.agentDir);
		const entry = fileURLToPath(
			new URL("../../../../host/node_modules/@gotgenes/pi-permission-system/src/index.ts", import.meta.url),
		);
		f.bundled.permissions = entry;
		const directory = join(f.agentDir, "extensions", "pi-permission-system");
		await mkdir(directory, { recursive: true });
		const config = JSON.stringify({
			permission: {
				"*": "allow",
				bash: { "*": "allow", "printf *": "deny" },
				path: { "*": "allow", "**/protected.txt": "deny" },
			},
		});
		await writeFile(join(directory, "config.json"), config);
		await writeFile(join(f.cwd, "protected.txt"), "Fixture content");
		const adapter = await f.prepare(true, false);
		const resourceLoader = new DefaultResourceLoader({
			cwd: f.cwd,
			agentDir: f.agentDir,
			settingsManager: adapter.settingsManager,
			noExtensions: true,
			additionalExtensionPaths: [entry],
			extensionsOverride: adapter.overrides,
			extensionFactories: [
				{
					name: "fixture-background",
					factory: (pi) => pi.registerTool({ ...createBashToolDefinition(f.cwd), name: "background_start" }),
				},
			],
		});
		await resourceLoader.reload();
		expect(resourceLoader.getExtensions().errors).toEqual([]);
		const { session } = await createAgentSession({
			cwd: f.cwd,
			agentDir: f.agentDir,
			settingsManager: adapter.settingsManager,
			resourceLoader,
			sessionManager: SessionManager.inMemory(f.cwd),
		});
		try {
			await session.bindExtensions({});
			for (const command of ["printf DENIED", "cat protected.txt"]) {
				const event = {
					type: "tool_call" as const,
					toolName: "background_start",
					toolCallId: command,
					input: { command },
				};
				expect(await session.extensionRunner.emitToolCall(event), command).toMatchObject({ block: true });
				expect(event.toolName).toBe("background_start");
			}
			expect(
				await session.extensionRunner.emitToolCall({
					type: "tool_call",
					toolName: "background_start",
					toolCallId: "allowed",
					input: { command: "echo ALLOWED" },
				}),
			).not.toMatchObject({ block: true });
			expect(await readFile(join(directory, "config.json"), "utf8")).toBe(config);
		} finally {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
		}
	}, 30_000);

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
			settingsManager: plan.settingsManager,
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
			settingsManager: plan.settingsManager,
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
				settingsManager: plan.settingsManager,
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
		// Ling's bundled switch preserves independently installed Pi resources.
		const full = await f.prepare(false);
		expect(full.paths.filter((path) => !path.startsWith("builtin:"))).toEqual([
			f.installedEntry("@juicesharp/rpiv-todo"),
			f.installedEntry("@gotgenes/pi-permission-system"),
		]);
		expect((await f.prepare(false, false)).paths.filter((path) => !path.startsWith("builtin:"))).toEqual([
			f.installedEntry("@juicesharp/rpiv-todo"),
			f.installedEntry("@gotgenes/pi-permission-system"),
		]);
	});

	it("honors local package identity and disabled entries without rewriting their recorded source", async () => {
		const f = await fixture();
		const local = join(f.cwd, "packages");
		const entries = new Map<string, string>();
		for (const name of ["@juicesharp/rpiv-todo", "@gotgenes/pi-permission-system", "@earendil-works/pi-voice"]) {
			const directory = join(local, name);
			await mkdir(directory, { recursive: true });
			await writeFile(
				join(directory, "package.json"),
				JSON.stringify({ name, version: "9.9.9", pi: { extensions: ["index.ts"] } }),
			);
			const entry = join(directory, "index.ts");
			await writeFile(entry, "export default function () {}");
			entries.set(name, entry);
		}
		await writeFile(
			join(f.agentDir, "settings.json"),
			JSON.stringify({ packages: [...entries.values()].map((entry) => join(entry, "..")) }),
		);
		const plan = await f.prepare(true, true, join(f.bundled.todo, "..", "voice.ts"));
		expect(plan.bundledPaths.size).toBe(0);
		expect(plan.paths.filter((path) => !path.startsWith("builtin:"))).toEqual([...entries.values()]);
		const full = await f.prepare(false);
		expect(full.paths).toContain(entries.get("@gotgenes/pi-permission-system"));
		expect(full.paths).toContain(entries.get("@juicesharp/rpiv-todo"));
		const loader = new DefaultResourceLoader({
			cwd: f.cwd,
			agentDir: f.agentDir,
			noExtensions: true,
			additionalExtensionPaths: plan.paths,
			extensionFactories: plan.factories,
		});
		await loader.reload();
		try {
			const loaded = loader.getExtensions();
			plan.decorate(loaded);
			expect(loaded.errors).toEqual([]);
			for (const extension of loaded.extensions.filter((extension) => !extension.path.startsWith("builtin:"))) {
				expect(extension.sourceInfo.source).not.toMatch(/^(npm:|ling:)/);
			}
		} finally {
			loader.getExtensions().runtime.invalidate("Fixture completed");
		}
		await writeFile(
			join(f.agentDir, "settings.json"),
			JSON.stringify({
				packages: [{ source: join(entries.get("@juicesharp/rpiv-todo")!, ".."), extensions: ["-index.ts"] }],
			}),
		);
		expect((await f.prepare(false)).paths).not.toContain(f.bundled.todo);
	});
});
