import { DefaultPackageManager } from "@earendil-works/pi-coding-agent";
import type { PiAdapterPlan } from "@ling/contracts/companions";
import { PERMISSION_PACKAGE } from "@ling/contracts/permissions";
import { piPackageSource } from "@ling/contracts/pi-tool-origin";
import { TODO_BUNDLED_SOURCE, TODO_PACKAGE } from "@ling/contracts/todo";
import { dirname } from "node:path";
import type { PiLoadExtensionsResult, PiSettingsManager } from "../types";
import { restoreToolFiltersOnShutdown } from "./pi-tool-filter-restore";

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
	if (plan.permissions?.enabled && !installed(PERMISSION_PACKAGE))
		bundled.set(plan.permissions.entry, PERMISSION_BUNDLED_SOURCE);
	const suppressed = plan.permissions && !plan.permissions.enabled ? `npm:${PERMISSION_PACKAGE}` : null;
	const resources = visible.filter((resource) => resource.enabled && sourceOf(resource) !== suppressed);
	const revocable = new Set([
		...resources.filter((resource) => sourceOf(resource) === `npm:${PERMISSION_PACKAGE}`).map((r) => r.path),
		...(plan.permissions ? [plan.permissions.entry] : []),
	]);
	return {
		paths: [...new Set([...resources.map((resource) => resource.path), ...bundled.keys()])],
		bundledPaths: new Set(bundled.keys()),
		overrides(base: PiLoadExtensionsResult): PiLoadExtensionsResult {
			for (const extension of base.extensions)
				if (revocable.has(extension.path)) restoreToolFiltersOnShutdown(extension, base.runtime);
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
