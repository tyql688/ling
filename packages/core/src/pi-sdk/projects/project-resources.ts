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
import { preparePiAdapters, createPiBuiltinExtensionFactories } from "../extensions/pi-adapters";
import { createPiTodoReconciliation } from "../extensions/pi-todo-reconciliation";
import type { McpUi } from "../mcp/mcp-extension";
import { assertPiModelsJsonWithinReadBound } from "../models/model-config-file";
import type { PiModelRuntimes } from "../models/model-runtime";
import type { LingSkillResources } from "../resources/skill-toggles";
import type {
	PiAgentSessionServices,
	PiExtensionUiContext,
	PiInlineExtension,
	PiSettingsManager,
	PiLoadExtensionsResult,
} from "../types";

/** Dependencies for creating catalog and session resource graphs under the same trust and adapter policy. */
export interface PiProjectResourceContext {
	loadCatalogResources: boolean;
	readAdapterPlan(cwd: string): Promise<PiAdapterPlan>;
	openVoiceSettings: ((ui: PiExtensionUiContext) => void) | undefined;
	mcpUi: McpUi | undefined;
	builtinExtensions(features: BuiltinFeatureFlags): PiInlineExtension[];
	projectTrustResolver(cwd: string, extensions: PiLoadExtensionsResult): Promise<boolean>;
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
	const createServices = async (modelRuntimeSignal?: AbortSignal) => {
		if (!owner.loadCatalogResources && !includeBuiltinExtensions) {
			// A session worker retains canonical cwd and project lifetime here.
			// Its runtime loads extensions and providers; the control worker loads the catalog.

			return createAgentSessionServices({
				...serviceOptions,
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
		const additionalExtensionPaths: string[] = [];
		let prepared:
			| {
					adapters: Awaited<ReturnType<typeof preparePiAdapters>>;
					classify: ReturnType<PiModelRuntimes["createProviderScopeClassifyingOverride"]>;
					installSkills: (loader: PiAgentSessionServices["resourceLoader"]) => void;
			  }
			| undefined;
		const services = await createAgentSessionServices({
			...serviceOptions,
			resourceLoaderReloadOptions: {
				resolveProjectTrust: async ({ extensionsResult }) => {
					const trusted = await owner.projectTrustResolver(options.cwd, extensionsResult);
					options.settingsManager.setProjectTrusted(trusted);
					await options.settingsManager.reload();
					const adapters = await preparePiAdapters({
						cwd: options.cwd,
						agentDir: options.agentDir,
						settingsManager: options.settingsManager,
						plan,
						sessionRuntime: includeBuiltinExtensions === true,
						...(owner.openVoiceSettings ? { openVoiceSettings: owner.openVoiceSettings } : {}),
						...(owner.mcpUi ? { mcpUi: owner.mcpUi } : {}),
					});
					throwIfOperationAborted(signal);
					if (includeBuiltinExtensions) additionalExtensionPaths.push(...adapters.bundledPaths);
					prepared = {
						adapters,
						classify: owner.createProviderScopeClassifyingOverride(
							options.agentDir,
							options.modelRuntime,
							resourceLoaderOptions?.extensionsOverride,
							adapters.bundledPaths,
						),
						installSkills: await owner.createLingSkillToggles(
							options.settingsManager,
							options.agentDir,
							options.cwd,
							adapters.skillInventory,
						),
					};
					return trusted;
				},
			},
			resourceLoaderOptions: {
				...resourceLoaderOptions,
				extensionFactories: [
					...(includeBuiltinExtensions ? createPiBuiltinExtensionFactories(options) : []),
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
				noExtensions: false,
				additionalExtensionPaths,
				extensionsOverride: (base: PiLoadExtensionsResult) => {
					if (!prepared) throw new Error("Pi resources resolved before project trust");
					return prepared.classify(prepared.adapters.overrides(base));
				},
			},
			...(modelRuntimeSignal ? { modelRuntimeSignal } : {}),
		});
		try {
			if (!prepared) throw new Error("Pi resource preparation did not complete");
			const { adapters, installSkills } = prepared;
			adapters.decorate(services.resourceLoader.getExtensions());
			owner.bundledAdapters.set(services, adapters.bundledEntries);
			installSkills(services.resourceLoader);
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
