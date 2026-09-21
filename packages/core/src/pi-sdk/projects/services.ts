import type { PiModelRuntimes } from "../models/model-runtime";
import { createPiToolOriginRecorder } from "../extensions/pi-tool-origin";
import { readPiExtensionIdentities } from "../extensions/pi-resource-identity";
import { preparePiAdapters } from "../extensions/pi-adapters";
import { createPiTodoReconciliation } from "../extensions/pi-todo-reconciliation";
import type { PiAdapterPlan } from "@ling/contracts/companions";
import type { BuiltinFeatureFlags } from "@ling/contracts/builtin-features";
import type { PiTurnLifecycle } from "../session/turn-lifecycle";
import type { PiInlineExtension, PiAgentSessionServices, PiSessionManager, PiSettingsManager } from "../types";
import {
	createAgentSessionServices,
	DefaultResourceLoader,
	type ModelRuntime,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { toCommandError } from "../../command-resolver";
import { requestCancelled, throwAggregateFailures, throwIfOperationAborted } from "../../ling-error";
import { createLogger } from "../../logger";
import { pathIdentity } from "../../paths";
import { assertNoBlockingDiagnostics, collectServiceDiagnostics } from "../diagnostics";
import { reconcilePiExtensionFlagValues } from "../extensions/extension-flags";
import { assertPiModelsJsonWithinReadBound } from "../models/model-config-file";
import type { LingSkillResources } from "../resources/skill-toggles";
import { createSettingsManager } from "../sdk-factories";

const log = createLogger("pi-sdk-services");

type ProjectState = "closed" | "opening" | "open" | "closing";

interface ProjectSlot {
	cwd: string;
	generation: number;
	lastCloseCompletionSequence: number;
	state: ProjectState;
	services: PiAgentSessionServices | undefined;
	runtimeServices: Set<PiAgentSessionServices>;
	openPromise: Promise<PiAgentSessionServices> | undefined;
	openingController: AbortController | undefined;
	closePromise: Promise<void> | undefined;
	/** Fences project-runtime reads/auth flows across a mutable provider overlay switch. */
	resourceReloadBarrier: Promise<void> | undefined;
	operations: Set<Promise<unknown>>;
}

interface PendingProjectOpen {
	promise: Promise<PiAgentSessionServices>;
	/** True when this request already waits for the current/queued reload. */
	reloadBlocked: boolean;
}

type ProjectCloseDrain = (cwd: string) => Promise<void>;

type ProjectTrustResolver = (cwd: string) => Promise<boolean>;

function invalidateServiceExtensionRuntime(services: PiAgentSessionServices, message: string): void {
	services.resourceLoader.getExtensions().runtime.invalidate(message);
}

/**
 * Pi caches compiled extension factories by cwd. A newly constructed ResourceLoader
 * intentionally reuses that cache, so rebuilding a project graph for the same cwd
 * would otherwise keep the pre-reload extension modules. Switch the SDK cache through
 * an inert cwd first; the following createAgentSessionServices() call then switches
 * back and imports a fresh project generation without mutating the live loader.
 */
async function prepareFreshProjectExtensionGeneration(cwd: string, agentDir: string): Promise<void> {
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

function createProjectSlot(cwd: string): ProjectSlot {
	return {
		cwd,
		generation: 0,
		lastCloseCompletionSequence: 0,
		state: "closed",
		services: undefined,
		runtimeServices: new Set(),
		openPromise: undefined,
		openingController: undefined,
		closePromise: undefined,
		resourceReloadBarrier: undefined,
		operations: new Set(),
	};
}

function projectLifecycleError(cwd: string, state: ProjectState): Error {
	const code = state === "closing" ? "PROJECT_CLOSING" : state === "opening" ? "PROJECT_OPENING" : "PROJECT_NOT_OPEN";
	const message =
		state === "closing"
			? `Project is closing: ${cwd}`
			: state === "opening"
				? `Project is still opening: ${cwd}`
				: `Project not open: ${cwd}`;
	return Object.assign(new Error(message), { code, cwd, state });
}

function openWasSupersededError(cwd: string): Error {
	return Object.assign(new Error(`Project opening was superseded: ${cwd}`), {
		code: "PROJECT_OPEN_SUPERSEDED" as const,
		cwd,
	});
}

function isCurrentOpen(slot: ProjectSlot, generation: number, services: PiAgentSessionServices): boolean {
	return slot.state === "open" && slot.generation === generation && slot.services === services;
}

function waitForProjectOperations(slot: ProjectSlot): Promise<void> {
	const pending = [...slot.operations];
	if (pending.length === 0) return Promise.resolve();
	return Promise.allSettled(pending).then(() => waitForProjectOperations(slot));
}
function afterSettled<T>(promise: Promise<T>, task: () => Promise<void>): Promise<void> {
	return promise.then(task, task);
}

type PiProjectServicesStateDependencies = {
	readAdapterPlan(cwd: string): Promise<PiAdapterPlan>;
	agentDir: string;
	modelRuntimes: Pick<
		PiModelRuntimes,
		| "createCwdModelRuntime"
		| "createProviderScopeClassifyingOverride"
		| "disposeCredentialRuntime"
		| "getCredentialRuntimeRegistry"
	>;
	turnLifecycle: Pick<PiTurnLifecycle, "createPiTurnLifecycleResourceOptions">;
	builtinExtensions(features: BuiltinFeatureFlags): PiInlineExtension[];
	resolveProjectTrust: ProjectTrustResolver;
	skillResources: LingSkillResources;
};

interface PiProjectServicesState {
	readAdapterPlan: PiProjectServicesStateDependencies["readAdapterPlan"];
	agentDir: PiProjectServicesStateDependencies["agentDir"];
	builtinExtensions: PiProjectServicesStateDependencies["builtinExtensions"];
	projectTrustResolver: PiProjectServicesStateDependencies["resolveProjectTrust"];
	createLingSkillToggles: PiProjectServicesStateDependencies["skillResources"]["createLingSkillToggles"];
	stopping: boolean;
	disposal: Promise<void> | null;
	createCwdModelRuntime: PiProjectServicesStateDependencies["modelRuntimes"]["createCwdModelRuntime"];
	createProviderScopeClassifyingOverride: PiProjectServicesStateDependencies["modelRuntimes"]["createProviderScopeClassifyingOverride"];
	disposeCredentialRuntime: PiProjectServicesStateDependencies["modelRuntimes"]["disposeCredentialRuntime"];
	getCredentialRuntimeRegistry: PiProjectServicesStateDependencies["modelRuntimes"]["getCredentialRuntimeRegistry"];
	createPiTurnLifecycleResourceOptions: PiProjectServicesStateDependencies["turnLifecycle"]["createPiTurnLifecycleResourceOptions"];
	projectSlots: Map<string, ProjectSlot>;
	projectAliases: Map<string, string>;
	pendingProjectOpens: Set<PendingProjectOpen>;
	runtimeServiceOwners: WeakMap<PiAgentSessionServices, ProjectSlot>;
	projectLifecycleSequence: number;
	modelCatalogChangedListeners: Set<() => void>;
	activeReload: Promise<void> | null;
	queuedReload: Promise<void> | null;
	queuedReloadProjects: Set<string> | null;
}

export function createPiProjectServices({
	readAdapterPlan,
	agentDir,
	modelRuntimes,
	turnLifecycle,
	builtinExtensions,
	resolveProjectTrust: projectTrustResolver,
	skillResources,
}: PiProjectServicesStateDependencies) {
	const owner: PiProjectServicesState = {
		readAdapterPlan,
		agentDir: agentDir,
		builtinExtensions: builtinExtensions,
		projectTrustResolver: projectTrustResolver,
		createLingSkillToggles: skillResources.createLingSkillToggles,
		stopping: false,
		disposal: null,
		createCwdModelRuntime: modelRuntimes.createCwdModelRuntime,
		createProviderScopeClassifyingOverride: modelRuntimes.createProviderScopeClassifyingOverride,
		disposeCredentialRuntime: modelRuntimes.disposeCredentialRuntime,
		getCredentialRuntimeRegistry: modelRuntimes.getCredentialRuntimeRegistry,
		createPiTurnLifecycleResourceOptions: turnLifecycle.createPiTurnLifecycleResourceOptions,
		projectSlots: new Map<string, ProjectSlot>(),
		projectAliases: new Map<string, string>(),
		pendingProjectOpens: new Set<PendingProjectOpen>(),
		runtimeServiceOwners: new WeakMap<PiAgentSessionServices, ProjectSlot>(),
		projectLifecycleSequence: 0,
		modelCatalogChangedListeners: new Set<() => void>(),
		activeReload: null,
		queuedReload: null,
		queuedReloadProjects: new Set(),
	};
	return {
		onPiModelCatalogChanged(listener: () => void): () => void {
			return onPiModelCatalogChanged(owner, listener);
		},
		readStoredProjectCredential(cwd: string, providerId: string) {
			return readStoredProjectCredential(owner, cwd, providerId);
		},
		hasProjectProviderCredentialConflict(cwd: string, providerId: string): boolean {
			return hasProjectProviderCredentialConflict(owner, cwd, providerId);
		},
		openProject(cwd: string): Promise<PiAgentSessionServices> {
			return openProject(owner, cwd);
		},
		closeProject(cwd: string, drain: ProjectCloseDrain): Promise<void> {
			return closeProject(owner, cwd, drain);
		},
		listOpenProjectPaths(): string[] {
			return listOpenProjectPaths(owner);
		},
		getPiServices(cwd: string): PiAgentSessionServices {
			return getPiServices(owner, cwd);
		},
		acquirePiRuntimeServices(
			cwd: string,
			options: {
				sessionManager: PiSessionManager;
				extensionFlagValues?: Map<string, boolean | string>;
			},
		): Promise<PiAgentSessionServices> {
			return acquirePiRuntimeServices(owner, cwd, options);
		},
		releasePiRuntimeServices(services: PiAgentSessionServices): void {
			return releasePiRuntimeServices(owner, services);
		},
		withOpenProject<T>(cwd: string, operation: (services: PiAgentSessionServices) => Promise<T>): Promise<T> {
			return withOpenProject(owner, cwd, operation);
		},
		reloadOpenProjectSettingsSnapshots(): Promise<void> {
			return reloadOpenProjectSettingsSnapshots(owner);
		},
		reloadProjectSettings(projectCwds?: readonly string[]): Promise<void> {
			return reloadProjectSettings(owner, projectCwds);
		},
		dispose(drain: ProjectCloseDrain): Promise<void> {
			return dispose(owner, drain);
		},
	};
}

/** Project lifecycle and resource reloads can change effective provider ownership
 * without touching models.json. Main subscribes once and projects this as the
 * renderer's existing models-changed event. */
function onPiModelCatalogChanged(owner: PiProjectServicesState, listener: () => void): () => void {
	owner.modelCatalogChangedListeners.add(listener);
	return () => {
		owner.modelCatalogChangedListeners.delete(listener);
	};
}

function emitPiModelCatalogChanged(owner: PiProjectServicesState): void {
	for (const listener of [...owner.modelCatalogChangedListeners]) {
		try {
			listener();
		} catch (error) {
			log.error("Pi model catalog listener failed:", error);
		}
	}
}

/** Raw credential read scoped to one effective project provider. The ownership
 * registry rechecks after I/O so a newly colliding extension cannot reveal a
 * profile secret through a stale project runtime. */
function readStoredProjectCredential(owner: PiProjectServicesState, cwd: string, providerId: string) {
	const services = getPiServices(owner, cwd);
	return owner.getCredentialRuntimeRegistry(services.agentDir).readStoredForRuntime(services.modelRuntime, providerId);
}

function hasProjectProviderCredentialConflict(owner: PiProjectServicesState, cwd: string, providerId: string): boolean {
	const services = getPiServices(owner, cwd);
	return owner.getCredentialRuntimeRegistry(services.agentDir).isProviderAmbiguous(services.modelRuntime, providerId);
}

async function createBoundedAgentSessionServices(
	owner: PiProjectServicesState,
	options: Parameters<typeof createAgentSessionServices>[0] & {
		agentDir: string;
		settingsManager: PiSettingsManager;
		includeBuiltinExtensions?: boolean;
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
	const plan = await owner.readAdapterPlan(options.cwd);
	const adapters = await preparePiAdapters({
		cwd: options.cwd,
		agentDir: options.agentDir,
		settingsManager: options.settingsManager,
		plan,
	});
	throwIfOperationAborted(signal);
	const trusted = options.settingsManager.isProjectTrusted();
	const createServices = async (modelRuntimeSignal?: AbortSignal) => {
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
					...(includeBuiltinExtensions ? owner.builtinExtensions(plan.features) : []),
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
			installSkillToggles(services.resourceLoader);
		} catch (error) {
			services.resourceLoader.getExtensions().runtime.invalidate("Ling Pi extension setup failed");
			throw error;
		}
		return services;
	};
	const runtime = options.modelRuntime;
	if (!signal || !runtime) return createServices();

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

function rememberProjectAlias(owner: PiProjectServicesState, alias: string, canonicalCwd: string): void {
	owner.projectAliases.set(pathIdentity(resolve(alias)), canonicalCwd);
	owner.projectAliases.set(pathIdentity(resolve(canonicalCwd)), canonicalCwd);
}

function forgetProjectAliases(owner: PiProjectServicesState, canonicalCwd: string): void {
	for (const [alias, target] of owner.projectAliases) {
		if (target === canonicalCwd) owner.projectAliases.delete(alias);
	}
}

function canPruneProjectSlot(owner: PiProjectServicesState, slot: ProjectSlot): boolean {
	return (
		slot.state === "closed" &&
		slot.services === undefined &&
		slot.openPromise === undefined &&
		slot.openingController === undefined &&
		slot.closePromise === undefined &&
		slot.resourceReloadBarrier === undefined &&
		slot.runtimeServices.size === 0 &&
		slot.operations.size === 0 &&
		// An open still resolving realpath may need this slot's close-completion fence.
		// Prune all closed slots when the final pending request settles instead.
		owner.pendingProjectOpens.size === 0
	);
}

function pruneProjectSlot(owner: PiProjectServicesState, slot: ProjectSlot): void {
	if (!canPruneProjectSlot(owner, slot) || owner.projectSlots.get(slot.cwd) !== slot) return;
	owner.projectSlots.delete(slot.cwd);
	forgetProjectAliases(owner, slot.cwd);
}

function pruneClosedProjectSlots(owner: PiProjectServicesState): void {
	if (owner.pendingProjectOpens.size > 0) return;
	for (const slot of owner.projectSlots.values()) pruneProjectSlot(owner, slot);
}

function knownCanonicalProjectPath(owner: PiProjectServicesState, cwd: string): string | undefined {
	const absolute = resolve(cwd);
	return owner.projectAliases.get(pathIdentity(absolute)) ?? (owner.projectSlots.has(absolute) ? absolute : undefined);
}

async function canonicalizeProjectPathForOpen(owner: PiProjectServicesState, cwd: string): Promise<string> {
	const absolute = resolve(cwd);
	const known = owner.projectAliases.get(pathIdentity(absolute));
	if (known && owner.projectSlots.get(known)?.state !== "closed") return known;
	try {
		const canonicalCwd = await realpath(absolute);
		if (!(await stat(canonicalCwd)).isDirectory()) throw new Error(`Project path is not a directory: ${canonicalCwd}`);
		rememberProjectAlias(owner, absolute, canonicalCwd);
		return canonicalCwd;
	} catch (error) {
		// A deleted folder keeps its project manageable: Pi holds the cwd as identity, so the
		// session list stays readable. Callers that require a real folder check before opening.
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			rememberProjectAlias(owner, absolute, absolute);
			return absolute;
		}
		throw toCommandError(error);
	}
}

async function canonicalizeProjectPathForClose(owner: PiProjectServicesState, cwd: string): Promise<string> {
	const absolute = resolve(cwd);
	const known = knownCanonicalProjectPath(owner, absolute);
	if (known && owner.projectSlots.get(known)?.state !== "closed") return known;
	try {
		const canonicalCwd = await realpath(absolute);
		rememberProjectAlias(owner, absolute, canonicalCwd);
		return canonicalCwd;
	} catch {
		// Closing is idempotent. If an unknown path disappeared before it could be
		// registered, there is no lifecycle slot left to drain.
		return known ?? absolute;
	}
}

async function createProjectServices(
	owner: PiProjectServicesState,
	slot: ProjectSlot,
	generation: number,
	resolveTrust: ProjectTrustResolver,
	signal: AbortSignal,
): Promise<PiAgentSessionServices> {
	let modelRuntime: ModelRuntime | null = null;
	let loadedServices: PiAgentSessionServices | null = null;
	try {
		throwIfOperationAborted(signal);
		const settingsManager = createSettingsManager(slot.cwd, owner.agentDir);
		await prepareFreshProjectExtensionGeneration(slot.cwd, owner.agentDir);
		throwIfOperationAborted(signal);
		modelRuntime = await owner.createCwdModelRuntime(slot.cwd, owner.agentDir, signal);
		throwIfOperationAborted(signal);
		const services = await createBoundedAgentSessionServices(
			owner,
			{
				cwd: slot.cwd,
				agentDir: owner.agentDir,
				modelRuntime,
				settingsManager,
				resourceLoaderReloadOptions: { resolveProjectTrust: () => resolveTrust(slot.cwd) },
			},
			signal,
		);
		loadedServices = services;
		throwIfOperationAborted(signal);
		if (slot.state !== "opening" || slot.generation !== generation) throw openWasSupersededError(slot.cwd);
		if (services.cwd !== slot.cwd) {
			throw new Error(`Pi returned a mismatched project path: expected ${slot.cwd}, received ${services.cwd}`);
		}
		const diagnostics = collectServiceDiagnostics(services);
		assertNoBlockingDiagnostics(`Failed to open project ${services.cwd}`, diagnostics);
		if (slot.state !== "opening" || slot.generation !== generation) throw openWasSupersededError(slot.cwd);

		slot.services = services;
		slot.state = "open";
		slot.openPromise = undefined;
		slot.openingController = undefined;
		log.info(`opened project agentDir=${services.agentDir} cwd=${services.cwd}`);
		emitPiModelCatalogChanged(owner);
		return services;
	} catch (error) {
		if (loadedServices) {
			invalidateServiceExtensionRuntime(
				loadedServices,
				"This project extension runtime is stale because the project failed to finish opening.",
			);
		}
		if (modelRuntime) owner.disposeCredentialRuntime(modelRuntime);
		if (slot.state === "opening" && slot.generation === generation) {
			slot.state = "closed";
			slot.services = undefined;
			slot.openPromise = undefined;
			slot.openingController = undefined;
		}
		throw toCommandError(signal.aborted && signal.reason instanceof Error ? signal.reason : error);
	}
}

function openCanonicalProject(
	owner: PiProjectServicesState,
	cwd: string,
	requestSequence: number,
): Promise<PiAgentSessionServices> {
	if (owner.stopping) return Promise.reject(requestCancelled("The Pi projects are shutting down."));
	let slot = owner.projectSlots.get(cwd);
	if (!slot) {
		slot = createProjectSlot(cwd);
		owner.projectSlots.set(cwd, slot);
	}
	rememberProjectAlias(owner, cwd, cwd);
	if (requestSequence < slot.lastCloseCompletionSequence) {
		return Promise.reject(openWasSupersededError(cwd));
	}
	if (slot.state === "open" && slot.services) return Promise.resolve(slot.services);
	if (slot.state === "opening" && slot.openPromise) return slot.openPromise;
	if (slot.state === "closing") return Promise.reject(projectLifecycleError(cwd, slot.state));

	slot.generation += 1;
	slot.state = "opening";
	const controller = new AbortController();
	slot.openingController = controller;
	const promise = createProjectServices(owner, slot, slot.generation, owner.projectTrustResolver, controller.signal);
	slot.openPromise = promise;
	return promise;
}

function openProject(owner: PiProjectServicesState, cwd: string): Promise<PiAgentSessionServices> {
	if (owner.stopping) return Promise.reject(requestCancelled("The Pi projects are shutting down."));
	owner.projectLifecycleSequence += 1;
	const requestSequence = owner.projectLifecycleSequence;
	const open = () =>
		canonicalizeProjectPathForOpen(owner, cwd).then((canonicalCwd) =>
			openCanonicalProject(owner, canonicalCwd, requestSequence),
		);
	// A project opened from files while a global resource pass is mutating existing
	// service graphs could otherwise publish a pre-mutation settings snapshot after
	// that pass has already selected its targets. Open only after the latest promised
	// pass (including follow-ups created in a settled promise reaction) settles, then
	// load the canonical files once. The blocked marker is sampled by reload target
	// selection, so update it synchronously before every await to avoid a wait cycle.
	const pendingState = { reloadBlocked: false };
	const operation = (async () => {
		while (true) {
			const reloadBarrier = owner.queuedReload ?? owner.activeReload;
			if (!reloadBarrier) {
				pendingState.reloadBlocked = false;
				return open();
			}
			pendingState.reloadBlocked = true;
			await reloadBarrier.then(
				() => undefined,
				() => undefined,
			);
		}
	})();
	const pending: PendingProjectOpen = {
		promise: operation,
		get reloadBlocked() {
			return pendingState.reloadBlocked;
		},
	};
	owner.pendingProjectOpens.add(pending);
	return operation.finally(() => {
		owner.pendingProjectOpens.delete(pending);
		pruneClosedProjectSlots(owner);
	});
}

function closeCanonicalProject(
	owner: PiProjectServicesState,
	slot: ProjectSlot,
	drain: ProjectCloseDrain,
	closeUnopenedSlot = false,
): Promise<void> {
	if (slot.state === "closed" && !closeUnopenedSlot) {
		owner.projectLifecycleSequence += 1;
		slot.lastCloseCompletionSequence = owner.projectLifecycleSequence;
		pruneProjectSlot(owner, slot);
		return Promise.resolve();
	}
	if (slot.state === "closing" && slot.closePromise) return slot.closePromise;

	const previousServices = slot.services;
	const opening = slot.openPromise;
	const openingController = slot.openingController;
	slot.generation += 1;
	const generation = slot.generation;
	slot.state = "closing";
	slot.openPromise = undefined;
	slot.openingController = undefined;
	openingController?.abort(openWasSupersededError(slot.cwd));

	const tracked: Promise<void> = (async () => {
		if (opening) await Promise.allSettled([opening]);
		await waitForProjectOperations(slot);
		await drain(slot.cwd);
		if (slot.runtimeServices.size > 0) {
			throw Object.assign(
				new Error(`Project still owns ${slot.runtimeServices.size} active Pi runtime service lease(s): ${slot.cwd}`),
				{ code: "PROJECT_RUNTIME_SERVICES_ACTIVE" as const, cwd: slot.cwd },
			);
		}
		if (slot.state === "closing" && slot.generation === generation) {
			if (previousServices) {
				invalidateServiceExtensionRuntime(
					previousServices,
					"This project extension runtime is stale because the project was closed.",
				);
				owner.disposeCredentialRuntime(previousServices.modelRuntime);
			}
			slot.services = undefined;
			slot.state = "closed";
			owner.projectLifecycleSequence += 1;
			slot.lastCloseCompletionSequence = owner.projectLifecycleSequence;
			log.info(`closed project cwd=${slot.cwd}`);
			emitPiModelCatalogChanged(owner);
		}
	})()
		.catch((error: unknown) => {
			if (slot.state === "closing" && slot.generation === generation) {
				slot.services = previousServices;
				slot.state = previousServices ? "open" : "closed";
				owner.projectLifecycleSequence += 1;
				slot.lastCloseCompletionSequence = owner.projectLifecycleSequence;
			}
			throw toCommandError(error);
		})
		.finally(() => {
			if (slot.closePromise === tracked) slot.closePromise = undefined;
			pruneProjectSlot(owner, slot);
		});
	slot.closePromise = tracked;
	return tracked;
}

function closeProject(owner: PiProjectServicesState, cwd: string, drain: ProjectCloseDrain): Promise<void> {
	return canonicalizeProjectPathForClose(owner, cwd).then((canonicalCwd) => {
		const existing = owner.projectSlots.get(canonicalCwd);
		if (existing) return closeCanonicalProject(owner, existing, drain);
		// Reserve the canonical slot before draining. This fences an open whose
		// realpath lookup began earlier through a different alias but resolves later.
		const slot = createProjectSlot(canonicalCwd);
		owner.projectSlots.set(canonicalCwd, slot);
		rememberProjectAlias(owner, resolve(cwd), canonicalCwd);
		return closeCanonicalProject(owner, slot, drain, true);
	});
}

function listOpenProjectPaths(owner: PiProjectServicesState): string[] {
	const paths: string[] = [];
	for (const slot of owner.projectSlots.values()) {
		if (slot.state === "open" && slot.services) paths.push(slot.cwd);
	}
	return paths;
}

function getPiServices(owner: PiProjectServicesState, cwd: string): PiAgentSessionServices {
	const absolute = resolve(cwd);
	const canonicalCwd = owner.projectAliases.get(pathIdentity(absolute)) ?? absolute;
	const slot = owner.projectSlots.get(canonicalCwd);
	if (slot?.state !== "open" || !slot.services) {
		throw projectLifecycleError(canonicalCwd, slot?.state ?? "closed");
	}
	return slot.services;
}

/** Creates the mutable Pi service graph owned by one AgentSession runtime generation.
 * Credentials and project settings are shared through their owning stores, while the
 * ModelRuntime provider overlay and resource loader are isolated. */
function acquirePiRuntimeServices(
	owner: PiProjectServicesState,
	cwd: string,
	options: {
		sessionManager: PiSessionManager;
		extensionFlagValues?: Map<string, boolean | string>;
	},
): Promise<PiAgentSessionServices> {
	let projectServices: PiAgentSessionServices;
	try {
		projectServices = getPiServices(owner, cwd);
	} catch (error) {
		return Promise.reject(toCommandError(error));
	}
	const slot = owner.projectSlots.get(projectServices.cwd);
	if (slot?.state !== "open" || slot.services !== projectServices) {
		return Promise.reject(projectLifecycleError(projectServices.cwd, slot?.state ?? "closed"));
	}
	const resolveTrust = owner.projectTrustResolver;
	const generation = slot.generation;
	const barrier = slot.resourceReloadBarrier;

	const create = async (): Promise<PiAgentSessionServices> => {
		if (!isCurrentOpen(slot, generation, projectServices)) {
			throw projectLifecycleError(projectServices.cwd, slot.state);
		}
		// A clean resource reconstruction uses a new ResourceLoader. Unlike calling
		// reload() on an already-loaded loader, Pi will otherwise reuse the cwd-scoped
		// compiled extension factories. Switch through an inert cwd first so ctx.reload()
		// observes extension file edits even when no main-process project reload ran.
		if (options.extensionFlagValues) {
			await prepareFreshProjectExtensionGeneration(projectServices.cwd, projectServices.agentDir);
			if (!isCurrentOpen(slot, generation, projectServices)) {
				throw projectLifecycleError(projectServices.cwd, slot.state);
			}
		}
		const modelRuntime = await owner.createCwdModelRuntime(projectServices.cwd, projectServices.agentDir);
		const turnLifecycleResources = owner.createPiTurnLifecycleResourceOptions(options.sessionManager);
		const toolOrigins = createPiToolOriginRecorder(options.sessionManager);
		// Ling's own extensions load ahead of the turn boundaries; moveStartExtensionFirst
		// re-finds the start boundary by path, so prepending here is safe.
		// Provider scope classification happens inside createBoundedAgentSessionServices,
		// wrapping the turn-lifecycle extensionsOverride carried by this spread.
		const resourceLoaderOptions = {
			...turnLifecycleResources,
			extensionFactories: [toolOrigins.extension, ...turnLifecycleResources.extensionFactories],
		};
		let runtimeServices: PiAgentSessionServices | null = null;
		try {
			runtimeServices = await createBoundedAgentSessionServices(owner, {
				includeBuiltinExtensions: true,
				cwd: projectServices.cwd,
				agentDir: projectServices.agentDir,
				modelRuntime,
				settingsManager: projectServices.settingsManager,
				resourceLoaderOptions,
				resourceLoaderReloadOptions: { resolveProjectTrust: () => resolveTrust(projectServices.cwd) },
			});
			if (options.extensionFlagValues) {
				// Pi's public extensionFlagValues option represents CLI argv: a boolean
				// entry means the flag was present (so even `false` becomes `true`) and a
				// removed flag is a blocking diagnostic. Ling restores live runtime state,
				// where false is meaningful and removed/type-changed flags must use the new
				// extension defaults, so reconcile only after the SDK has loaded the graph.
				reconcilePiExtensionFlagValues(runtimeServices.resourceLoader, options.extensionFlagValues);
			}
			toolOrigins.setResources(await readPiExtensionIdentities(runtimeServices));
			if (!isCurrentOpen(slot, generation, projectServices)) {
				throw projectLifecycleError(projectServices.cwd, slot.state);
			}
			if (runtimeServices.cwd !== projectServices.cwd) {
				throw new Error(
					`Pi returned a mismatched runtime project path: expected ${projectServices.cwd}, received ${runtimeServices.cwd}`,
				);
			}
			assertNoBlockingDiagnostics(
				`Failed to create runtime services for ${projectServices.cwd}`,
				collectServiceDiagnostics(runtimeServices),
			);
			if (!isCurrentOpen(slot, generation, projectServices)) {
				throw projectLifecycleError(projectServices.cwd, slot.state);
			}
			slot.runtimeServices.add(runtimeServices);
			owner.runtimeServiceOwners.set(runtimeServices, slot);
			return runtimeServices;
		} catch (error) {
			if (runtimeServices) {
				invalidateServiceExtensionRuntime(
					runtimeServices,
					"This extension ctx is stale because its Ling session runtime generation failed to initialize.",
				);
			}
			owner.disposeCredentialRuntime(modelRuntime);
			throw error;
		}
	};
	const tracked: Promise<PiAgentSessionServices> = (
		barrier ? barrier.then(create, create) : Promise.resolve().then(create)
	).finally(() => slot.operations.delete(tracked));
	slot.operations.add(tracked);
	return tracked;
}

function releasePiRuntimeServices(owner: PiProjectServicesState, services: PiAgentSessionServices): void {
	const slot = owner.runtimeServiceOwners.get(services);
	if (!slot) return;
	owner.runtimeServiceOwners.delete(services);
	slot.runtimeServices.delete(services);
	invalidateServiceExtensionRuntime(
		services,
		"This extension ctx is stale because its Ling session runtime generation was released.",
	);
	owner.disposeCredentialRuntime(services.modelRuntime);
	pruneProjectSlot(owner, slot);
}

/** Runs a cwd-bound read while holding the project open. The lease is registered
 * before the callback starts, so a concurrent close waits for the operation and
 * no new lease can enter after the slot transitions to `closing`. */
function withOpenProject<T>(
	owner: PiProjectServicesState,
	cwd: string,
	operation: (services: PiAgentSessionServices) => Promise<T>,
): Promise<T> {
	let services: PiAgentSessionServices;
	try {
		services = getPiServices(owner, cwd);
	} catch (error) {
		return Promise.reject(toCommandError(error));
	}
	const canonicalCwd = services.cwd;
	const slot = owner.projectSlots.get(canonicalCwd);
	if (slot?.state !== "open" || slot.services !== services) {
		return Promise.reject(projectLifecycleError(canonicalCwd, slot?.state ?? "closed"));
	}
	const barrier = slot.resourceReloadBarrier;
	const run = () => {
		if (slot.state !== "open" || slot.services !== services) {
			return Promise.reject(projectLifecycleError(canonicalCwd, slot.state));
		}
		return operation(services);
	};
	const tracked: Promise<T> = (barrier ? barrier.then(run, run) : Promise.resolve().then(run)).finally(() =>
		slot.operations.delete(tracked),
	);
	slot.operations.add(tracked);
	return tracked;
}

/** In-place settings refresh for value-only settings mutations (defaults, delivery
 * modes, compaction/retry values, shell/npm paths). Pi reads these lazily through
 * the shared SettingsManager instances at use time, so refreshing those instances
 * reaches every live session without rebuilding any project or session generation.
 * Resource-affecting settings (skill commands) still require reloadProjectSettings. */
async function reloadOpenProjectSettingsSnapshots(owner: PiProjectServicesState): Promise<void> {
	const managers = new Set<PiSettingsManager>();
	for (const slot of owner.projectSlots.values()) {
		if (slot.state !== "open" || !slot.services) continue;
		managers.add(slot.services.settingsManager);
		// Runtime generations created before an earlier project reload can still hold
		// the previous manager instance until their session rebuilds.
		for (const runtimeServices of slot.runtimeServices) managers.add(runtimeServices.settingsManager);
	}
	const results = await Promise.allSettled([...managers].map((manager) => manager.reload()));
	const failures = results.flatMap((result) => (result.status === "rejected" ? [toCommandError(result.reason)] : []));
	throwAggregateFailures(failures, `Failed to refresh ${failures.length} Pi settings snapshot(s)`);
}

function reloadProjectSettings(owner: PiProjectServicesState, projectCwds?: readonly string[]): Promise<void> {
	if (owner.activeReload || owner.queuedReload) {
		if (projectCwds === undefined) owner.queuedReloadProjects = null;
		else for (const cwd of projectCwds) owner.queuedReloadProjects?.add(cwd);
	}
	if (!owner.activeReload && owner.queuedReload) return owner.queuedReload;
	if (owner.activeReload) {
		owner.queuedReload ??= afterSettled(owner.activeReload, () => {
			const projects = owner.queuedReloadProjects === null ? undefined : [...owner.queuedReloadProjects];
			owner.queuedReloadProjects = new Set();
			owner.queuedReload = null;
			return reloadProjectSettings(owner, projects);
		});
		return owner.queuedReload;
	}
	owner.activeReload = reloadProjectSettingsNow(owner, projectCwds).finally(() => {
		owner.activeReload = null;
	});
	return owner.activeReload;
}

async function reloadProjectSettingsNow(owner: PiProjectServicesState, projectCwds?: readonly string[]): Promise<void> {
	const errors: Error[] = [];
	const details: string[] = [];
	// Opens/failed closes which began before this pass must settle before target
	// selection. Opens admitted after the pass began are fenced in openProject().
	// This prevents a project from completing with a settings generation that the
	// reload pass never observed.
	const lifecycleOperations = new Set<Promise<unknown>>(
		[...owner.projectSlots.values()].flatMap((slot) => [
			...(slot.openPromise ? [slot.openPromise] : []),
			...(slot.closePromise ? [slot.closePromise] : []),
		]),
	);
	// An open can still be canonicalizing and therefore have no ProjectSlot yet.
	// Wait for requests admitted before this pass. Requests already blocked on a
	// reload are excluded because waiting on this pass would form a cycle.
	for (const pending of owner.pendingProjectOpens) {
		if (!pending.reloadBlocked) lifecycleOperations.add(pending.promise);
	}
	await Promise.allSettled(lifecycleOperations);
	const selected = projectCwds === undefined ? null : new Set(projectCwds);
	const targets = [...owner.projectSlots.values()].flatMap((slot) => {
		if (slot.state !== "open" || !slot.services) return [];
		if (selected && !selected.has(slot.cwd)) return [];
		return [
			{
				slot,
				services: slot.services,
				generation: slot.generation,
				priorOperations: [...slot.operations],
			},
		];
	});
	const resolveTrust = owner.projectTrustResolver;

	// Start in a microtask so every target publishes its barrier before this pass
	// can reach the first mutable settings/provider step. All projects remain fenced
	// until the complete pass settles, so credential ownership never exposes a
	// half-reloaded cross-project generation.
	const reloadPass = Promise.resolve().then(async () => {
		await Promise.allSettled(targets.flatMap((target) => target.priorOperations));
		for (const { slot, services, generation } of targets) {
			let candidateModelRuntime: ModelRuntime | null = null;
			let candidateServices: PiAgentSessionServices | null = null;
			try {
				if (!isCurrentOpen(slot, generation, services)) continue;
				// Build a complete project generation beside the live one. Reusing and
				// mutating the live ResourceLoader first would leave settings, extensions,
				// and provider overlays from different generations when validation fails.
				const candidateSettingsManager = createSettingsManager(services.cwd, services.agentDir);
				await candidateSettingsManager.reload();
				if (!isCurrentOpen(slot, generation, services)) continue;
				await prepareFreshProjectExtensionGeneration(services.cwd, services.agentDir);
				if (!isCurrentOpen(slot, generation, services)) continue;
				candidateModelRuntime = await owner.createCwdModelRuntime(services.cwd, services.agentDir);
				if (!isCurrentOpen(slot, generation, services)) continue;
				candidateServices = await createBoundedAgentSessionServices(owner, {
					cwd: services.cwd,
					agentDir: services.agentDir,
					modelRuntime: candidateModelRuntime,
					settingsManager: candidateSettingsManager,
					resourceLoaderReloadOptions: { resolveProjectTrust: () => resolveTrust(services.cwd) },
				});
				if (!isCurrentOpen(slot, generation, services)) continue;
				if (candidateServices.cwd !== services.cwd) {
					throw new Error(
						`Pi returned a mismatched project path: expected ${services.cwd}, received ${candidateServices.cwd}`,
					);
				}
				assertNoBlockingDiagnostics(
					`Failed to reload project settings for ${services.cwd}`,
					collectServiceDiagnostics(candidateServices),
				);
				if (!isCurrentOpen(slot, generation, services)) continue;

				const previousModelRuntime = services.modelRuntime;
				const previousExtensionRuntime = services.resourceLoader.getExtensions().runtime;
				// All targets remain behind their barrier, so these synchronous assignments
				// publish one coherent generation while preserving the stable service-object
				// identity already captured by admitted project operations.
				services.modelRuntime = candidateServices.modelRuntime;
				services.settingsManager = candidateServices.settingsManager;
				services.resourceLoader = candidateServices.resourceLoader;
				services.diagnostics = candidateServices.diagnostics;
				candidateServices = null;
				candidateModelRuntime = null;
				previousExtensionRuntime.invalidate(
					"This project extension runtime is stale because its resource catalog was reloaded.",
				);
				owner.disposeCredentialRuntime(previousModelRuntime);
			} catch (error) {
				const normalized = toCommandError(error);
				errors.push(normalized);
				details.push(`${services.cwd}: ${normalized.message}`);
				log.error(`reload failed for ${services.cwd}:`, error);
			} finally {
				if (candidateServices) {
					invalidateServiceExtensionRuntime(
						candidateServices,
						"This project extension runtime is stale because its replacement generation was rejected.",
					);
				}
				if (candidateModelRuntime) owner.disposeCredentialRuntime(candidateModelRuntime);
			}
		}
		if (errors.length > 0) {
			throw new AggregateError(errors, `Failed to reload ${errors.length} open Pi project(s): ${details.join("; ")}`);
		}
	});

	for (const { slot } of targets) {
		const barrier: Promise<void> = reloadPass
			.then(
				() => undefined,
				() => undefined,
			)
			.finally(() => {
				slot.operations.delete(barrier);
				if (slot.resourceReloadBarrier === barrier) slot.resourceReloadBarrier = undefined;
			});
		slot.resourceReloadBarrier = barrier;
		slot.operations.add(barrier);
	}

	try {
		await reloadPass;
	} finally {
		// Even a profile-only reload (no open projects) changes Models settings.
		// Partial project reloads can also publish useful catalog changes before an
		// aggregate error, so renderer readers must reconcile in both cases.
		emitPiModelCatalogChanged(owner);
	}
}

function dispose(owner: PiProjectServicesState, drain: ProjectCloseDrain): Promise<void> {
	if (owner.disposal) return owner.disposal;
	owner.stopping = true;
	for (const slot of owner.projectSlots.values())
		slot.openingController?.abort(requestCancelled("The Pi projects are shutting down."));
	owner.disposal = (async () => {
		// Accepted reloads own their errors and must finish before project graphs are released.
		await Promise.allSettled([
			...(owner.queuedReload ? [owner.queuedReload] : owner.activeReload ? [owner.activeReload] : []),
			...[...owner.pendingProjectOpens].map((pending) => pending.promise),
		]);
		const results = await Promise.allSettled(
			[...owner.projectSlots.values()].map((slot) => closeCanonicalProject(owner, slot, drain)),
		);
		owner.modelCatalogChangedListeners.clear();
		pruneClosedProjectSlots(owner);
		throwAggregateFailures(
			results.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
			"Failed to dispose Pi project services",
		);
	})();
	return owner.disposal;
}

export type PiProjectServices = ReturnType<typeof createPiProjectServices>;
