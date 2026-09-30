import { createImageGenerationExtension } from "@ling/builtin-extensions";
import type { BuiltinFeatureFlags } from "@ling/contracts/builtin-features";
import type { PiAdapterPlan } from "@ling/contracts/companions";
import {
	createAgentSessionServices,
	DefaultResourceLoader,
	type ModelRuntime,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { join, resolve } from "node:path";
import { throwIfOperationAborted } from "../../ling-error";
import { preparePiAdapters } from "../extensions/pi-adapters";
import { createPiTodoReconciliation } from "../extensions/pi-todo-reconciliation";
import type { McpUi } from "../mcp/mcp-extension";
import { assertPiModelsJsonWithinReadBound } from "../models/model-config-file";
import type { PiModelRuntimes } from "../models/model-runtime";
import type { LingSkillResources } from "../resources/skill-toggles";
import type { PiAgentSessionServices, PiExtensionUiContext, PiInlineExtension, PiSettingsManager } from "../types";

/** Dependencies for creating catalog and session resource graphs under the same trust and adapter policy. */
export interface PiProjectResourceContext {
	loadCatalogResources: boolean;
	readAdapterPlan(cwd: string): Promise<PiAdapterPlan>;
	openVoiceSettings: ((ui: PiExtensionUiContext) => void) | undefined;
	mcpUi: McpUi | undefined;
	builtinExtensions(features: BuiltinFeatureFlags): PiInlineExtension[];
	projectTrustResolver(cwd: string): Promise<boolean>;
	createLingSkillToggles: LingSkillResources["createLingSkillToggles"];
	createProviderScopeClassifyingOverride: PiModelRuntimes["createProviderScopeClassifyingOverride"];
	bundledAdapters: WeakMap<PiAgentSessionServices, ReadonlyMap<string, string>>;
}

/**
 * Pi caches compiled extension factories by cwd. A newly constructed ResourceLoader
 * intentionally reuses that cache, so rebuilding a project graph for the same cwd
 * would otherwise keep the pre-reload extension modules. Switch the SDK cache through
 * an inert cwd first; the following createAgentSessionServices() call then switches
 * back and imports a fresh project generation without mutating the live loader.
 */
export async function prepareFreshProjectExtensionGeneration(cwd: string, agentDir: string): Promise<void> {
	const firstResetCwd = join(agentDir, ".ling-extension-cache-reset");
	const resetCwd =
		resolve(firstResetCwd) === resolve(cwd) ? join(agentDir, ".ling-extension-cache-reset-2") : firstResetCwd;
	const loader = new DefaultResourceLoader({
		cwd: resetCwd,
		agentDir,
		settingsManager: SettingsManager.inMemory({}),
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	try {
		await loader.reload();
	} finally {
		loader.getExtensions().runtime.invalidate("This inert extension runtime only resets Pi's cwd-scoped module cache.");
	}
}

export async function createBoundedAgentSessionServices(
	owner: PiProjectResourceContext,
	options: Parameters<typeof createAgentSessionServices>[0] & {
		agentDir: string;
		settingsManager: PiSettingsManager;
		includeBuiltinExtensions?: boolean;
		modelRuntime: ModelRuntime;
	},
	signal?: AbortSignal,
): ReturnType<typeof createAgentSessionServices> {
	// Pi performs another models.json refresh after applying extension provider
	// registrations. Recheck immediately before handing control to that SDK path.
	await assertPiModelsJsonWithinReadBound(options.agentDir, signal);
	throwIfOperationAborted(signal);
	const resourceLoaderOptions = options.resourceLoaderOptions;
	const { includeBuiltinExtensions, ...serviceOptions } = options;
	// Resolve Ling's existing trust decision before routing any project path through Pi's explicit-path loader.
	options.settingsManager.setProjectTrusted(await owner.projectTrustResolver(options.cwd));
	await options.settingsManager.reload();
	const trusted = options.settingsManager.isProjectTrusted();
	const createServices = async (modelRuntimeSignal?: AbortSignal) => {
		if (!owner.loadCatalogResources && !includeBuiltinExtensions) {
			// A session worker needs canonical cwd, trusted settings and a project lifecycle owner.
			// Its actual runtime loads the complete extension/provider graph below. The control
			// worker remains the catalog owner, so this shell must not execute every extension twice.
			return createAgentSessionServices({
				...serviceOptions,
				resourceLoaderReloadOptions: { resolveProjectTrust: async () => trusted },
				resourceLoaderOptions: {
					noExtensions: true,
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
					noContextFiles: true,
				},
				...(modelRuntimeSignal ? { modelRuntimeSignal } : {}),
			});
		}
		const plan = await owner.readAdapterPlan(options.cwd);
		const adapters = await preparePiAdapters({
			cwd: options.cwd,
			agentDir: options.agentDir,
			settingsManager: options.settingsManager,
			plan,
			loadBundled: includeBuiltinExtensions === true,
			...(owner.openVoiceSettings ? { openVoiceSettings: owner.openVoiceSettings } : {}),
			...(owner.mcpUi ? { mcpUi: owner.mcpUi } : {}),
		});
		throwIfOperationAborted(signal);
		const installSkillToggles = owner.createLingSkillToggles(options.settingsManager, options.agentDir);
		const classify = owner.createProviderScopeClassifyingOverride(
			options.agentDir,
			options.modelRuntime,
			resourceLoaderOptions?.extensionsOverride,
			adapters.bundledPaths,
		);
		const services = await createAgentSessionServices({
			...serviceOptions,
			resourceLoaderReloadOptions: { resolveProjectTrust: async () => trusted },
			resourceLoaderOptions: {
				...resourceLoaderOptions,
				extensionFactories: [
					...(includeBuiltinExtensions ? adapters.factories : []),
					...(includeBuiltinExtensions ? owner.builtinExtensions(plan.features) : []),
					...(includeBuiltinExtensions
						? [
								{
									name: "ling-image-generation",
									replaceable: true,
									factory: createImageGenerationExtension(options.modelRuntime),
								},
							]
						: []),
					...(includeBuiltinExtensions && plan.features.todo ? [createPiTodoReconciliation()] : []),
					...(resourceLoaderOptions?.extensionFactories ?? []),
				],
				noExtensions: true,
				additionalExtensionPaths: adapters.paths,
				extensionsOverride: (base: Parameters<typeof classify>[0]) => classify(adapters.overrides(base)),
			},
			...(modelRuntimeSignal ? { modelRuntimeSignal } : {}),
		});
		try {
			adapters.decorate(services.resourceLoader.getExtensions());
			owner.bundledAdapters.set(services, adapters.bundledEntries);
			installSkillToggles(services.resourceLoader);
		} catch (error) {
			services.resourceLoader.getExtensions().runtime.invalidate("Ling Pi extension setup failed");
			throw error;
		}
		return services;
	};
	const runtime = options.modelRuntime;
	if (!signal) return createServices();

	// The SDK's service factory accepts a create-time model signal, but an injected
	// ModelRuntime is refreshed without it. This runtime is not published yet, so bind
	// the project-open signal around the factory and restore the instance method before
	// the candidate can escape.
	const refresh = runtime.refresh;
	const ownsRefresh = Object.hasOwn(runtime, "refresh");
	runtime.refresh = (refreshOptions = {}) =>
		refresh.call(runtime, refreshOptions.signal === undefined ? { ...refreshOptions, signal } : refreshOptions);
	try {
		return await createServices(signal);
	} finally {
		if (ownsRefresh) runtime.refresh = refresh;
		else Reflect.deleteProperty(runtime, "refresh");
	}
}
