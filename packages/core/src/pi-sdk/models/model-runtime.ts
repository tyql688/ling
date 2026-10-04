import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { isAbsolute, relative } from "node:path";
import { requestCancelled, throwIfOperationAborted, waitForOperation } from "../../ling-error";
import type { PiLoadExtensionsResult } from "../types";
import { PiCredentialRuntimeRegistry } from "./credential-runtime-registry";
import {
	createPiCredentialStore,
	type PiCredentialProfileStore,
	type PiStoredCredentialMutationObserver,
	type PiStoredCredentialRestoreTarget,
	type PiStoredCredentialSnapshot,
} from "./credential-store";
import { assertPiModelsJsonWithinReadBound, createPiModelConfigReadGuard, piModelsJsonPath } from "./model-config-file";

interface GlobalModelRuntimeReplacementOptions {
	signal?: AbortSignal;
	validate?: (runtime: ModelRuntime) => void | Promise<void>;
	/** Synchronous final guard invoked inside auth.json mutations made through this runtime. */
	assertCredentialMutationAllowed?: (providerId: string) => void;
	/** Synchronous observation of the exact auth.json values around a guarded mutation. */
	observeCredentialMutation?: PiStoredCredentialMutationObserver;
}

export function createPiModelRuntimes(defaultAgentDir: string) {
	const installPiModelConfigReadGuard = createPiModelConfigReadGuard();
	let disposal: Promise<void> | null = null;
	let disposed = false;

	const globalModelRuntimePromises = new Map<string, Promise<ModelRuntime>>();

	const sharedCredentialStores = new Map<string, PiCredentialProfileStore>();

	const credentialRuntimeRegistries = new Map<string, PiCredentialRuntimeRegistry>();

	function getSharedCredentialStore(agentDir = defaultAgentDir): PiCredentialProfileStore {
		assertActive();
		const existing = sharedCredentialStores.get(agentDir);
		if (existing) return existing;
		const created = createPiCredentialStore(agentDir);
		sharedCredentialStores.set(agentDir, created);
		return created;
	}

	/** Reads raw profile credentials under the runtime's cooperative lock for settings reveal and provider account requests. Returns literal `!command` and `$ENV` references. */
	function readStoredProfileCredential(providerId: string) {
		return getCredentialRuntimeRegistry().readStoredForProfile(providerId);
	}

	function hasProfileProviderCredentialConflict(providerId: string): boolean {
		return getCredentialRuntimeRegistry().isProviderAmbiguousForProfile(providerId);
	}

	/** Removes a profile credential only while project-provider ownership remains unambiguous,
	 * returning the exact raw JSON entry from the same locked transaction. */
	function deleteStoredProfileCredentialSnapshot(
		providerId: string,
		assertMutationAllowed?: () => void,
	): Promise<PiStoredCredentialSnapshot> {
		return getCredentialRuntimeRegistry().deleteProfileCredentialSnapshot(providerId, assertMutationAllowed);
	}

	/** Compare-and-restore for a higher-level profile transaction. This bypasses ordinary
	 * admission guards only for an exact compensating write: the credential store refuses
	 * to overwrite any value other than this transaction's attempted publication. */
	async function restoreStoredProfileCredentialSnapshot(
		providerId: string,
		attempted: PiStoredCredentialSnapshot,
		target: PiStoredCredentialRestoreTarget,
	): Promise<PiStoredCredentialSnapshot> {
		return getSharedCredentialStore().restoreSnapshotChecked(providerId, attempted, target);
	}

	function getCredentialRuntimeRegistry(agentDir = defaultAgentDir): PiCredentialRuntimeRegistry {
		assertActive();
		const existing = credentialRuntimeRegistries.get(agentDir);
		if (existing) return existing;
		const created = new PiCredentialRuntimeRegistry(getSharedCredentialStore(agentDir));
		credentialRuntimeRegistries.set(agentDir, created);
		return created;
	}

	function disposeCredentialRuntime(runtime: ModelRuntime): void {
		for (const registry of credentialRuntimeRegistries.values()) registry.disposeRuntime(runtime);
	}

	async function createProfileModelRuntime(
		agentDir = defaultAgentDir,
		signal?: AbortSignal,
		assertCredentialMutationAllowed?: (providerId: string) => void,
		observeCredentialMutation?: PiStoredCredentialMutationObserver,
	): Promise<ModelRuntime> {
		assertActive();
		throwIfOperationAborted(signal);
		await waitForOperation(assertPiModelsJsonWithinReadBound(agentDir, signal), signal);
		assertActive();
		throwIfOperationAborted(signal);
		const credentials = getCredentialRuntimeRegistry(agentDir).createProfileCredentialStore(
			assertCredentialMutationAllowed,
			observeCredentialMutation,
		);
		const runtime = await ModelRuntime.create({
			credentials,
			modelsPath: piModelsJsonPath(agentDir),
			allowModelNetwork: false,
			...(signal ? { signal } : {}),
		});
		assertActive();
		throwIfOperationAborted(signal);
		installPiModelConfigReadGuard(runtime, agentDir);
		return runtime;
	}

	async function createCwdModelRuntime(
		cwd: string,
		agentDir = defaultAgentDir,
		signal?: AbortSignal,
	): Promise<ModelRuntime> {
		assertActive();
		throwIfOperationAborted(signal);
		await waitForOperation(assertPiModelsJsonWithinReadBound(agentDir, signal), signal);
		assertActive();
		throwIfOperationAborted(signal);
		const scope = getCredentialRuntimeRegistry(agentDir).createScope(cwd);
		try {
			const runtime = await ModelRuntime.create({
				credentials: scope.credentials,
				modelsPath: piModelsJsonPath(agentDir),
				allowModelNetwork: false,
				...(signal ? { signal } : {}),
			});
			assertActive();
			throwIfOperationAborted(signal);
			installPiModelConfigReadGuard(runtime, agentDir);
			scope.bindRuntime(runtime);
			return runtime;
		} catch (error) {
			scope.abandon();
			throw error;
		}
	}

	/** Records providers registered by global extensions resolved under agentDir. Pi discards extension paths when it drains pendingProviderRegistrations after this hook, so every project and session graph classifies them here. Extension.sourceInfo is synthetic ("temporary"); file location determines scope. Global providers can then share profile credentials across projects. */
	function createProviderScopeClassifyingOverride(
		agentDir: string,
		modelRuntime: ModelRuntime | undefined,
		inner?: (base: PiLoadExtensionsResult) => PiLoadExtensionsResult,
		userExtensionPaths?: ReadonlySet<string>,
	): (base: PiLoadExtensionsResult) => PiLoadExtensionsResult {
		return (base) => {
			if (modelRuntime) {
				const isGlobal = (extensionPath: string): boolean => {
					if (userExtensionPaths?.has(extensionPath)) return true;
					const resolvedPath = base.extensions.find((ext) => ext.path === extensionPath)?.resolvedPath;
					if (resolvedPath === undefined) return false;
					const rel = relative(agentDir, resolvedPath);
					return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
				};
				const userScoped = [
					...base.runtime.pendingProviderRegistrations.map((entry) => ({ id: entry.name, path: entry.extensionPath })),
					...base.runtime.pendingNativeProviderRegistrations.map((entry) => ({
						id: entry.provider.id,
						path: entry.extensionPath,
					})),
				]
					.filter((entry) => isGlobal(entry.path))
					.map((entry) => entry.id);
				getCredentialRuntimeRegistry(agentDir).recordUserScopedProviders(modelRuntime, userScoped);
			}
			return inner ? inner(base) : base;
		};
	}

	/** Model runtime for profile Models/Auth settings and catalog refresh. Project and session graphs require their own cwd-bound generation for mutable extension registrations. */
	function getGlobalModelRuntime(): Promise<ModelRuntime> {
		assertActive();
		const agentDir = defaultAgentDir;
		const existing = globalModelRuntimePromises.get(agentDir);
		if (existing) return existing;
		const creation = createProfileModelRuntime(agentDir);
		globalModelRuntimePromises.set(agentDir, creation);
		void creation.catch(() => {
			if (globalModelRuntimePromises.get(agentDir) === creation) globalModelRuntimePromises.delete(agentDir);
		});
		return creation;
	}

	/** Rebuilds the profile-only catalog as a complete offline generation.
	 * Pi refresh() mutates the live runtime after reloading models.json; constructing
	 * beside the published generation lets Ling retain the previous catalog if validation
	 * or provider composition fails, then publish only after the replacement succeeds. */
	async function replaceGlobalModelRuntime(options: GlobalModelRuntimeReplacementOptions = {}): Promise<ModelRuntime> {
		const agentDir = defaultAgentDir;
		const runtime = await createProfileModelRuntime(
			agentDir,
			options.signal,
			options.assertCredentialMutationAllowed,
			options.observeCredentialMutation,
		);
		await options.validate?.(runtime);
		throwIfOperationAborted(options.signal);
		assertActive();
		globalModelRuntimePromises.set(agentDir, Promise.resolve(runtime));
		return runtime;
	}

	function assertActive(): void {
		if (disposed) throw requestCancelled("The Pi model runtimes have been disposed.");
	}
	function hasAmbiguousPiProviderCredential(runtime: ModelRuntime, providerId: string): boolean {
		assertActive();
		return [...credentialRuntimeRegistries.values()].some((registry) =>
			registry.isProviderAmbiguous(runtime, providerId),
		);
	}

	function dispose(): Promise<void> {
		if (disposal) return disposal;
		disposed = true;
		for (const registry of credentialRuntimeRegistries.values()) registry.dispose();
		const stores = [...sharedCredentialStores.values()];
		const creations = [...globalModelRuntimePromises.values()];
		disposal = (async () => {
			// Cancel owner-backed command resolutions before draining catalog construction.
			await Promise.allSettled(stores.map((store) => store.dispose()));
			await Promise.allSettled(creations);
			credentialRuntimeRegistries.clear();
			sharedCredentialStores.clear();
			globalModelRuntimePromises.clear();
		})();
		return disposal;
	}

	return {
		readStoredProfileCredential,
		hasProfileProviderCredentialConflict,
		deleteStoredProfileCredentialSnapshot,
		restoreStoredProfileCredentialSnapshot,
		getCredentialRuntimeRegistry,
		disposeCredentialRuntime,
		createCwdModelRuntime,
		createProviderScopeClassifyingOverride,
		getGlobalModelRuntime,
		replaceGlobalModelRuntime,
		hasAmbiguousPiProviderCredential,
		dispose,
	};
}

export type PiModelRuntimes = ReturnType<typeof createPiModelRuntimes>;
