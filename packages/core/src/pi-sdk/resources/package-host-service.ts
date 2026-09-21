import type { PiSettings } from "../settings/settings";
import { type PluginProgressEvent, PLUGIN_SOURCE_LIST_MAX_ITEMS } from "@ling/contracts/plugin";
import { isLingError, throwAggregateFailures } from "@ling/core/ling-error";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pLimit from "p-limit";
import { requireCommand, toCommandError } from "../../command-resolver";
import { expandTildePath } from "../../paths";
import {
	type ConfiguredPluginPackage,
	type PluginHostErrorDto,
	type PluginHostRequest,
	type PluginHostResponse,
	type PluginMutationHostResult,
	type PluginPackageScope,
	type PluginResolvedInventory,
	type PluginResolvedResource,
	type PluginUpdate,
	parsePluginHostResponse,
} from "../../plugin-host/protocol";
import { normalizePluginSource, pluginSourceUsesGit, pluginSourceUsesNpm } from "../../plugin-host/source";
import { createPiPackageManagerHandle } from "../sdk-factories";
import type { PiSettingsManager } from "../types";

function localOption(scope: PluginPackageScope): { local: boolean } {
	return { local: scope === "project" };
}

/** Mirrors Pi's resolvePath() identity rules for configured local packages.
 * This fallback is needed only when Pi cannot report an installedPath because
 * the configured package has already disappeared from disk. */
function resolveConfiguredLocalPackage(source: string, baseDir: string): string {
	let normalized = expandTildePath(source);
	if (/^file:\/\//.test(normalized)) {
		normalized = fileURLToPath(normalized);
	}
	return isAbsolute(normalized) ? resolve(normalized) : resolve(baseDir, normalized);
}

/** Pi mutations resolve local arguments from cwd, while persisted entries are settings-relative. */
function configuredMutationSource(pkg: ConfiguredPluginPackage, baseDirs: Record<PluginPackageScope, string>): string {
	return pluginSourceUsesNpm(pkg.source) || pluginSourceUsesGit(pkg.source)
		? pkg.source
		: (pkg.installedPath ?? resolveConfiguredLocalPackage(pkg.source, baseDirs[pkg.scope]));
}

function settingsPersistenceError(settingsManager: PiSettingsManager, action: string): Error | undefined {
	const errors = settingsManager.drainErrors();
	if (errors.length === 0) return undefined;
	const detail = errors.map(({ scope, error }) => `${scope}: ${error.message}`).join("; ");
	return new Error(`Failed to persist Pi settings after plugin ${action} (${detail})`, {
		cause: errors[0]?.error,
	});
}

async function runMutation<Result>(
	action: string,
	settingsManager: PiSettingsManager,
	operation: () => Promise<Result>,
): Promise<Result> {
	let outcome: { status: "completed"; value: Result } | { status: "failed"; error: Error };
	try {
		outcome = { status: "completed", value: await operation() };
	} catch (error) {
		outcome = { status: "failed", error: toCommandError(error) };
	}

	let flushError: Error | undefined;
	try {
		await settingsManager.flush();
	} catch (error) {
		flushError = toCommandError(error);
	}
	const persistenceError = settingsPersistenceError(settingsManager, action);
	const errors = [outcome.status === "failed" ? outcome.error : undefined, flushError, persistenceError].filter(
		(error): error is Error => error !== undefined,
	);
	throwAggregateFailures(errors, errors.map((error) => error.message).join("; "));
	if (outcome.status === "failed") throw outcome.error;
	return outcome.value;
}

function configuredPackage(pkg: {
	source: string;
	scope: "user" | "project";
	filtered: boolean;
	installedPath?: string;
}): ConfiguredPluginPackage {
	return {
		source: normalizePluginSource(pkg.source),
		scope: pkg.scope === "user" ? "global" : "project",
		filtered: pkg.filtered,
		installedPath: pkg.installedPath ?? null,
	};
}

function resolvedResource(
	kind: PluginResolvedResource["kind"],
	resource: {
		path: string;
		enabled: boolean;
		metadata: {
			source: string;
			scope: "user" | "project" | "temporary";
			origin: "package" | "top-level";
			baseDir?: string;
		};
	},
): PluginResolvedResource {
	return {
		kind,
		path: resource.path,
		enabled: resource.enabled,
		metadata: {
			source: normalizePluginSource(resource.metadata.source),
			scope: resource.metadata.scope === "user" ? "global" : resource.metadata.scope,
			origin: resource.metadata.origin === "top-level" ? "topLevel" : "package",
			baseDir: resource.metadata.baseDir ?? null,
		},
	};
}

async function resolveInventory(packageManager: {
	listConfiguredPackages(): Array<{
		source: string;
		scope: "user" | "project";
		filtered: boolean;
		installedPath?: string;
	}>;
	resolve(onMissing: (source: string) => Promise<"skip">): Promise<{
		extensions: Array<Parameters<typeof resolvedResource>[1]>;
		skills: Array<Parameters<typeof resolvedResource>[1]>;
		prompts: Array<Parameters<typeof resolvedResource>[1]>;
		themes: Array<Parameters<typeof resolvedResource>[1]>;
	}>;
}): Promise<PluginResolvedInventory> {
	const missingSources = new Set<string>();
	const resolved = await packageManager.resolve(async (source) => {
		missingSources.add(normalizePluginSource(source));
		return "skip";
	});
	return {
		configuredPackages: packageManager.listConfiguredPackages().map(configuredPackage),
		resources: [
			...resolved.extensions.map((resource) => resolvedResource("extension", resource)),
			...resolved.skills.map((resource) => resolvedResource("skill", resource)),
			...resolved.prompts.map((resource) => resolvedResource("prompt", resource)),
			...resolved.themes.map((resource) => resolvedResource("theme", resource)),
		],
		missingSources: [...missingSources].sort(),
	};
}

function updateInfo(update: {
	source: string;
	displayName: string;
	type: "npm" | "git";
	scope: "user" | "project";
}): PluginUpdate {
	return {
		source: normalizePluginSource(update.source),
		displayName: update.displayName,
		type: update.type,
		scope: update.scope === "user" ? "global" : "project",
	};
}

function hostError(
	request: PluginHostRequest,
	error: unknown,
	code: PluginHostErrorDto["code"],
	outcome: PluginHostErrorDto["outcome"],
): PluginHostResponse {
	const normalized = toCommandError(error);
	return {
		kind: "error",

		method: request.method,
		error: {
			code,
			// Error messages are truncated to the protocol message bound (2000 chars)
			message: normalized.message.slice(0, 2_000) || "Pi package operation failed.",
			retryable: code === "REQUEST_DEADLINE_EXCEEDED",
			outcome,
			...(isLingError(normalized) ? { cause: normalized.lingError } : {}),
		},
	};
}

function mutationResult(scopePrecision: PluginMutationHostResult["scopePrecision"]): PluginMutationHostResult {
	return { completed: true, settingsChanged: "unknown", scopePrecision };
}

export function createPiPackageHostService(settings: PiSettings) {
	let stopping = false;
	let disposal: Promise<void> | null = null;
	const pendingRequests = new Set<Promise<PluginHostResponse>>();
	function dispose(): Promise<void> {
		if (disposal) return disposal;
		stopping = true;
		disposal = Promise.allSettled([...pendingRequests]).then(() => undefined);
		return disposal;
	}
	const { getPiNpmCommandExecutable } = settings;
	const { refreshHttpProxyFromSettings } = settings.network;

	// All package operations in the host process share one serial tail: npm/settings writes must not run concurrently
	const requestQueue = pLimit(1);

	function ensureCommandsForPluginSources(sources: readonly string[], { git = true }: { git?: boolean } = {}): void {
		if (sources.length > PLUGIN_SOURCE_LIST_MAX_ITEMS) throw new Error("Invalid plugin source list");
		if (sources.some(pluginSourceUsesNpm)) requireCommand(getPiNpmCommandExecutable());
		if (git && sources.some(pluginSourceUsesGit)) requireCommand("git");
	}

	async function processPluginHostRequest(
		request: PluginHostRequest,
		onProgress: (event: PluginProgressEvent) => void,
	): Promise<PluginHostResponse> {
		if (Date.now() >= request.deadlineAt) {
			return hostError(
				request,
				new Error("Plugin host request deadline expired."),
				"REQUEST_DEADLINE_EXCEEDED",
				"knownFailed",
			);
		}
		const mutation = request.method === "install" || request.method === "remove" || request.method === "update";
		let mutationAdmitted = false;
		try {
			refreshHttpProxyFromSettings();
			const { packageManager, settingsManager, packageSourceBaseDirs } = createPiPackageManagerHandle(
				request.cwd,
				onProgress,
				"projectTrusted" in request ? { projectTrusted: request.projectTrusted } : undefined,
			);
			switch (request.method) {
				case "resolve":
					return {
						kind: "result",

						method: request.method,
						result: await resolveInventory(packageManager),
					};
				case "checkUpdates":
					ensureCommandsForPluginSources(packageManager.listConfiguredPackages().map((pkg) => pkg.source));
					return {
						kind: "result",

						method: request.method,
						result: { updates: (await packageManager.checkForAvailableUpdates()).map(updateInfo) },
					};
				case "install": {
					const source = normalizePluginSource(request.source);
					ensureCommandsForPluginSources([source]);
					mutationAdmitted = true;
					await runMutation("install", settingsManager, () =>
						packageManager.installAndPersist(source, localOption(request.scope)),
					);
					return { kind: "result", method: request.method, result: mutationResult("exact") };
				}
				case "remove": {
					const source = normalizePluginSource(request.source);
					ensureCommandsForPluginSources([source], { git: false });
					const configured = packageManager
						.listConfiguredPackages()
						.map(configuredPackage)
						.find((pkg) => pkg.source === source && pkg.scope === request.scope);
					if (!configured) throw new Error(`Package is not configured in ${request.scope} scope: ${source}`);
					// Pi stores local package paths relative to the settings file which owns them,
					// but removeAndPersist() resolves its input relative to cwd. Pass the resolved
					// package identity so an installed (or now-missing) local package removes the
					// exact configured entry instead of silently reporting an unchanged no-op.
					const removalSource = configuredMutationSource(configured, packageSourceBaseDirs);
					mutationAdmitted = true;
					const changed = await runMutation("remove", settingsManager, () =>
						packageManager.removeAndPersist(removalSource, localOption(request.scope)),
					);
					if (!changed) throw new Error(`Pi did not remove the configured ${request.scope} package: ${source}`);
					return {
						kind: "result",

						method: request.method,
						result: {
							completed: true,
							settingsChanged: "changed",
							scopePrecision: "exact",
						},
					};
				}
				case "update": {
					const source = request.source === null ? null : normalizePluginSource(request.source);
					if (request.scope !== "global" && !settingsManager.isProjectTrusted()) {
						throw new Error("Project is not trusted; refusing to update project packages");
					}
					const configured = packageManager.listConfiguredPackages().map(configuredPackage);
					const targets = configured.filter(
						(pkg) =>
							(request.scope === "all" || pkg.scope === request.scope) &&
							(source === null || pkg.source === source || pkg.installedPath === source),
					);
					const sources = [...new Set(targets.map((pkg) => configuredMutationSource(pkg, packageSourceBaseDirs)))];
					if (source !== null && sources.length === 0) {
						throw new Error(`Package is not configured in ${request.scope} scope: ${source}`);
					}
					// A settings-relative string can name different local packages in each scope.
					// Require an absolute path or one scope instead of choosing the first package.
					if (source !== null && sources.length > 1) {
						throw new Error("Package source is ambiguous across scopes; use its absolute path or one scope");
					}
					ensureCommandsForPluginSources(sources);
					mutationAdmitted = true;
					await runMutation("update", settingsManager, async () => {
						if (request.scope === "all" && source === null) {
							await packageManager.update();
							return;
						}
						for (const mutationSource of sources) await packageManager.update(mutationSource);
					});
					return { kind: "result", method: request.method, result: mutationResult("piIdentityWide") };
				}
			}
		} catch (error) {
			return hostError(
				request,
				error,
				"PI_PACKAGE_OPERATION_FAILED",
				mutation && mutationAdmitted ? "unknown" : "knownFailed",
			);
		}
	}

	/** All requests share one queue so reads never observe a half-flushed settings mutation. */
	function handlePluginHostRequest(
		request: PluginHostRequest,
		onProgress: (event: PluginProgressEvent) => void,
	): Promise<PluginHostResponse> {
		if (stopping)
			return Promise.resolve(
				hostError(
					request,
					new Error("The Pi package host is shutting down."),
					"PI_PACKAGE_OPERATION_FAILED",
					"knownFailed",
				),
			);
		const operation = requestQueue(async () => {
			const response = await processPluginHostRequest(request, onProgress);
			try {
				return parsePluginHostResponse(response);
			} catch (error) {
				const mutation = request.method === "install" || request.method === "remove" || request.method === "update";
				return hostError(request, error, "PI_PACKAGE_OPERATION_FAILED", mutation ? "unknown" : "knownFailed");
			}
		});

		pendingRequests.add(operation);
		return operation.finally(() => pendingRequests.delete(operation));
	}
	return { handlePluginHostRequest, dispose };
}
