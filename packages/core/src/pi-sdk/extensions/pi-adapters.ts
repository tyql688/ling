import { MCP_BUILTIN_SOURCE } from "@ling/contracts/mcp";
import { adaptMcpExtension, type McpUi } from "../mcp/mcp-extension";
import { readPiMcpConfiguration } from "../mcp/pi-mcp";
import {
	createCodemodeExtension,
	createMcpExtension,
	createToolSearchExtension,
	DefaultPackageManager,
} from "@earendil-works/pi-coding-agent";
import type { PiAdapterPlan } from "@ling/contracts/companions";
import { PERMISSION_PACKAGE } from "@ling/contracts/permissions";
import { piPackageSource } from "@ling/contracts/pi-tool-origin";
import { TODO_BUNDLED_SOURCE, TODO_PACKAGE } from "@ling/contracts/todo";
import { isPiVoiceSource, VOICE_BUNDLED_SOURCE } from "@ling/contracts/voice";
import { dirname, join } from "node:path";
import { z } from "zod";
import { readUtf8FileBounded } from "../../store/atomic-file-store";
import type { PiExtensionUiContext, PiInlineExtension, PiLoadExtensionsResult, PiSettingsManager } from "../types";
import { restoreToolFiltersOnShutdown } from "./pi-tool-filter-restore";
import { supportsPiVoice } from "../voice/pi-voice-modules";
import { createLogger } from "../../logger";
import { isRecord } from "@ling/contracts/records";
import { createLingError } from "../../ling-error";

const log = createLogger("pi-adapters");

const PERMISSION_BUNDLED_SOURCE = "ling:permission-system";
const permissionSources = new WeakMap<PiLoadExtensionsResult["extensions"][number], "bundled" | "external">();

function permissionUnavailable(message: string) {
	return createLingError({ code: "PI_PERMISSION_UNAVAILABLE", category: "compatibility", retryable: false, message });
}

/** Identity is verified from package metadata while resolving each resource generation. */
export function getPiPermissionSource(result: PiLoadExtensionsResult): "bundled" | "external" | "none" {
	for (const extension of result.extensions) {
		const source = permissionSources.get(extension);
		if (source) return source;
	}
	return "none";
}

/**
 * Decides which bundled Pi packages join a project's extension inventory.
 * A package the user installed through Pi always wins over the bundled copy. Ling
 * may independently enable the bundled permission package.
 */
export async function preparePiAdapters(options: {
	cwd: string;
	agentDir: string;
	settingsManager: PiSettingsManager;
	plan: PiAdapterPlan;
	sessionRuntime: boolean;
	openVoiceSettings?: (ui: PiExtensionUiContext) => void;
	mcpUi?: McpUi;
}) {
	const { plan, settingsManager } = options;
	const inventory = await new DefaultPackageManager({
		cwd: options.cwd,
		agentDir: options.agentDir,
		settingsManager,
		builtinExtensions: ["codemode", "tool-search", "mcp"],
	}).resolve();
	const trusted = settingsManager.isProjectTrusted();
	const visible = inventory.extensions.filter((resource) => resource.metadata.scope !== "project" || trusted);
	const packageNames = new Map<string, Promise<string | null>>();
	const identities = new Map<string, string>();
	await Promise.all(
		visible.map(async (resource) => {
			const source = piPackageSource(
				resource.metadata.origin === "top-level" ? resource.path : resource.metadata.source,
			);
			const root = resource.metadata.packageRoot;
			if (resource.metadata.origin === "package" && root && !source.startsWith("npm:")) {
				if (!packageNames.has(root)) {
					packageNames.set(
						root,
						(async () => {
							// Pi also accepts convention-based directories without a package manifest.
							const manifest = await readUtf8FileBounded(join(root, "package.json"), 256 * 1024);
							return manifest === undefined
								? null
								: (z.object({ name: z.string().optional() }).parse(JSON.parse(manifest)).name ?? null);
						})(),
					);
				}
				const name = await packageNames.get(root)!;
				// Package identity selects the active copy; recorded provenance keeps Pi's actual source.
				identities.set(resource.path, name ? `npm:${name}` : source);
			} else identities.set(resource.path, source);
		}),
	);
	const identityOf = (resource: (typeof visible)[number]) => identities.get(resource.path)!;
	const installed = (name: string) => visible.some((resource) => identityOf(resource) === `npm:${name}`);
	const bundled = new Map<string, string>();
	if (plan.todo && !installed(TODO_PACKAGE)) bundled.set(plan.todo, TODO_BUNDLED_SOURCE);
	if (plan.voice && !visible.some((resource) => isPiVoiceSource(identityOf(resource))))
		bundled.set(plan.voice, VOICE_BUNDLED_SOURCE);
	if (plan.permissions?.enabled && !installed(PERMISSION_PACKAGE)) {
		if (!plan.permissions.entry && options.sessionRuntime)
			throw permissionUnavailable(
				"The permission system is enabled but its package is unavailable. Repair or install the Pi permission package before opening this project.",
			);
		if (plan.permissions.entry) bundled.set(plan.permissions.entry, PERMISSION_BUNDLED_SOURCE);
	}

	const resources = visible.filter((resource) => resource.enabled);
	const voicePaths = new Set<string>();
	if (plan.features.voice && options.openVoiceSettings) {
		const candidates = [
			...resources.filter((resource) => isPiVoiceSource(identityOf(resource))).map((resource) => resource.path),
			...[...bundled].filter(([, source]) => source === VOICE_BUNDLED_SOURCE).map(([path]) => path),
		];
		for (const path of candidates) {
			try {
				if (await supportsPiVoice(path)) voicePaths.add(path);
			} catch (error) {
				log.warn("Could not verify Pi Voice compatibility; preserving its original commands", error);
			}
		}
	}
	const revocable = new Set([
		...resources.filter((resource) => identityOf(resource) === `npm:${PERMISSION_PACKAGE}`).map((r) => r.path),
		...(plan.permissions?.entry ? [plan.permissions.entry] : []),
	]);
	return {
		skillInventory: inventory.skills,
		bundledPaths: new Set(bundled.keys()),
		bundledEntries: new Map([...bundled].map(([path, source]) => [source, path])),
		overrides(base: PiLoadExtensionsResult): PiLoadExtensionsResult {
			for (const extension of base.extensions) {
				if (identities.get(extension.path) === `npm:${PERMISSION_PACKAGE}`)
					permissionSources.set(extension, "external");
				else if (bundled.get(extension.path) === PERMISSION_BUNDLED_SOURCE) permissionSources.set(extension, "bundled");
				if (permissionSources.has(extension)) {
					const gates = extension.handlers.get("tool_call");
					if (!gates?.length)
						throw permissionUnavailable("The Pi permission package did not register a tool-call gate.");
					extension.handlers.set(
						"tool_call",
						gates.map((gate) => (event, ctx) => {
							// Host background commands use the permission package's complete Bash gate stack.
							// The original event and every other extension retain the registered tool's identity.
							return gate(
								isRecord(event) && event.type === "tool_call" && event.toolName === "background_start"
									? { ...event, toolName: "bash" }
									: event,
								ctx,
							);
						}),
					);
				}
				if (extension.path === MCP_BUILTIN_SOURCE && options.mcpUi) adaptMcpExtension(extension, options.mcpUi);
				if (revocable.has(extension.path)) restoreToolFiltersOnShutdown(extension, base.runtime);
				if (voicePaths.has(extension.path) && options.openVoiceSettings) {
					const open = options.openVoiceSettings;
					for (const name of ["voice-settings", "transcribe"]) {
						const command = extension.commands.get(name);
						if (command) extension.commands.set(name, { ...command, handler: async (_args, ctx) => open(ctx.ui) });
					}
					// Ling captures the client's microphone. Never let an upstream terminal shortcut
					// record the Host's device in a browser or remote session.
					extension.shortcuts.clear();
					// Version 0.1.0's startup listener only advertises terminal setup shortcuts.
					// Ling's microphone control owns first-use setup instead.
					extension.handlers.delete("session_start");
				}
			}
			if (options.sessionRuntime && plan.permissions?.enabled && getPiPermissionSource(base) === "none")
				throw permissionUnavailable(
					"The permission system is enabled but no active Pi permission extension was loaded. Enable or repair the Pi permission package before opening this project.",
				);
			return base;
		},
		decorate(base: PiLoadExtensionsResult) {
			for (const extension of base.extensions) {
				const source = bundled.get(extension.path);
				if (!source) continue;
				extension.sourceInfo = {
					path: extension.path,
					source,
					origin: "package",
					scope: "user",
					baseDir: dirname(extension.path),
				};
				for (const tool of extension.tools.values()) tool.sourceInfo = extension.sourceInfo;
				for (const command of extension.commands.values()) command.sourceInfo = extension.sourceInfo;
			}
		},
	};
}

/** Native built-ins participate in Pi resource filtering and extension replacement. */
export function createPiBuiltinExtensionFactories(options: {
	cwd: string;
	agentDir: string;
	settingsManager: PiSettingsManager;
}): PiInlineExtension[] {
	const { settingsManager } = options;
	const factories: PiInlineExtension[] = [
		{ name: "codemode", builtin: true, replaceable: true, factory: createCodemodeExtension() },
		{ name: "tool-search", builtin: true, replaceable: true, factory: createToolSearchExtension() },
	];
	factories.push({
		name: "mcp",
		builtin: true,
		replaceable: true,
		factory: async (pi) => {
			let configuration: Awaited<ReturnType<typeof readPiMcpConfiguration>> | undefined;
			// Pi awaits session-start listeners in registration order, including after replacement.
			pi.on("session_start", async () => {
				configuration = await readPiMcpConfiguration(
					options.agentDir,
					settingsManager.isProjectTrusted() ? options.cwd : null,
				);
			});
			await createMcpExtension({
				loadConfig: () => {
					if (!configuration) throw new Error("MCP configuration has not loaded for this session.");
					return configuration.loaded;
				},
			})(pi);
		},
	});
	return factories;
}
