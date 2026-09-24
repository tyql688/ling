import { DefaultPackageManager } from "@earendil-works/pi-coding-agent";
import type { PiAdapterPlan } from "@ling/contracts/companions";
import { PERMISSION_PACKAGE } from "@ling/contracts/permissions";
import { piPackageSource } from "@ling/contracts/pi-tool-origin";
import { TODO_BUNDLED_SOURCE, TODO_PACKAGE } from "@ling/contracts/todo";
import { isPiVoiceSource, VOICE_BUNDLED_SOURCE } from "@ling/contracts/voice";
import { dirname } from "node:path";
import type { PiExtensionUiContext, PiLoadExtensionsResult, PiSettingsManager } from "../types";
import { restoreToolFiltersOnShutdown } from "./pi-tool-filter-restore";
import { supportsPiVoice } from "../voice/pi-voice-modules";
import { createLogger } from "../../logger";

const log = createLogger("pi-adapters");

const PERMISSION_BUNDLED_SOURCE = "ling:permission-system";

/**
 * Decides which bundled Pi packages join a project's extension inventory.
 * A package the user installed through Pi always wins over the bundled copy, and a project
 * without the permission system loads neither copy of it.
 */
export async function preparePiAdapters(options: {
	cwd: string;
	agentDir: string;
	settingsManager: PiSettingsManager;
	plan: PiAdapterPlan;
	openVoiceSettings?: (ui: PiExtensionUiContext) => void;
}) {
	const { plan, settingsManager } = options;
	const inventory = await new DefaultPackageManager({
		cwd: options.cwd,
		agentDir: options.agentDir,
		settingsManager,
	}).resolve();
	const trusted = settingsManager.isProjectTrusted();
	const visible = inventory.extensions.filter((resource) => resource.metadata.scope !== "project" || trusted);
	const sourceOf = (resource: (typeof visible)[number]) =>
		piPackageSource(resource.metadata.origin === "top-level" ? resource.path : resource.metadata.source);
	const installed = (name: string) => visible.some((resource) => sourceOf(resource) === `npm:${name}`);
	const bundled = new Map<string, string>();
	if (plan.todo && !installed(TODO_PACKAGE)) bundled.set(plan.todo, TODO_BUNDLED_SOURCE);
	if (plan.voice && !visible.some((resource) => isPiVoiceSource(sourceOf(resource))))
		bundled.set(plan.voice, VOICE_BUNDLED_SOURCE);
	if (plan.permissions?.enabled && !installed(PERMISSION_PACKAGE))
		bundled.set(plan.permissions.entry, PERMISSION_BUNDLED_SOURCE);
	const suppressed = plan.permissions && !plan.permissions.enabled ? `npm:${PERMISSION_PACKAGE}` : null;
	const resources = visible.filter((resource) => resource.enabled && sourceOf(resource) !== suppressed);
	const voicePaths = new Set<string>();
	if (plan.features.voice && options.openVoiceSettings) {
		const candidates = [
			...resources.filter((resource) => isPiVoiceSource(sourceOf(resource))).map((resource) => resource.path),
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
		...resources.filter((resource) => sourceOf(resource) === `npm:${PERMISSION_PACKAGE}`).map((r) => r.path),
		...(plan.permissions ? [plan.permissions.entry] : []),
	]);
	return {
		paths: [...new Set([...resources.map((resource) => resource.path), ...bundled.keys()])],
		bundledPaths: new Set(bundled.keys()),
		overrides(base: PiLoadExtensionsResult): PiLoadExtensionsResult {
			for (const extension of base.extensions) {
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
