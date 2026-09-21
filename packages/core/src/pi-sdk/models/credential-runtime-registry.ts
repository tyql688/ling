import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { throwIfOperationAborted } from "@ling/core/ling-error";
import { resolve } from "node:path";
import type {
	PiCredentialProfileStore,
	PiCredentialStore,
	PiStoredCredentialMutationObserver,
	PiStoredCredentialSnapshot,
} from "./credential-store";

interface RuntimeCredentialScope {
	readonly cwd: string;
	runtime: ModelRuntime | null;
	registeredProviderIds: Set<string>;
	effectiveProviderIds: Set<string>;
	/** Provider ids registered at load time by user-scope (global) extensions. The same
	 * global package registering the same id in every open project is not a conflict. */
	userScopedProviderIds: Set<string>;
	disposed: boolean;
}

interface PiRuntimeCredentialScope {
	credentials: PiCredentialStore;
	bindRuntime(runtime: ModelRuntime): void;
	abandon(): void;
}

class AmbiguousPiProviderCredentialError extends Error {
	readonly code = "AMBIGUOUS_PROVIDER_CREDENTIAL";

	constructor(readonly providerId: string) {
		super(
			`Stored credentials for provider "${providerId}" are disabled because a project extension overrides that provider id across multiple projects`,
		);
		this.name = "AmbiguousPiProviderCredentialError";
	}
}

class StalePiCredentialRuntimeError extends Error {
	readonly code = "STALE_CREDENTIAL_RUNTIME";

	constructor() {
		super("The Pi credential runtime is no longer active");
		this.name = "StalePiCredentialRuntimeError";
	}
}

/**
 * Tracks the extension-provider ownership of every cwd-bound ModelRuntime.
 *
 * The profile auth file intentionally remains shared with the Pi CLI. When two
 * projects register different implementations under the same provider id, that
 * shared key no longer has a safe owner. Stored reads and all scoped writes then
 * fail closed; provider-local literal/env auth still works when no stored entry
 * exists. Multiple live runtimes from one canonical cwd remain one safe scope.
 */
export class PiCredentialRuntimeRegistry {
	private disposed = false;
	dispose(): void {
		this.disposed = true;
		for (const scope of [...this.scopes]) this.disposeScope(scope);
	}
	private readonly scopes = new Set<RuntimeCredentialScope>();
	private readonly scopesByRuntime = new WeakMap<ModelRuntime, RuntimeCredentialScope>();

	constructor(private readonly profileCredentials: PiCredentialProfileStore) {}

	createScope(cwd: string): PiRuntimeCredentialScope {
		if (this.disposed) throw new StalePiCredentialRuntimeError();
		const scope: RuntimeCredentialScope = {
			cwd: resolve(cwd),
			runtime: null,
			registeredProviderIds: new Set(),
			effectiveProviderIds: new Set(),
			userScopedProviderIds: new Set(),
			disposed: false,
		};
		const credentials = this.createScopedStore(scope);
		this.scopes.add(scope);
		return {
			credentials,
			bindRuntime: (runtime) => {
				this.assertActive(scope);
				if (scope.runtime) throw new Error("Pi credential runtime scope is already bound");
				scope.runtime = runtime;
				this.scopesByRuntime.set(runtime, scope);
				this.refreshProviderIds(scope);
			},
			abandon: () => this.disposeScope(scope),
		};
	}

	/** Called once per runtime generation from the resource loader's extensionsOverride,
	 * before Pi drains pending registrations and drops their extension paths. Later dynamic
	 * registrations keep the load-time scope; an id never seen here stays project-owned. */
	recordUserScopedProviders(runtime: ModelRuntime, providerIds: Iterable<string>): void {
		const scope = this.scopesByRuntime.get(runtime);
		if (!scope || scope.disposed) return;
		for (const providerId of providerIds) scope.userScopedProviderIds.add(providerId);
	}

	disposeRuntime(runtime: ModelRuntime): void {
		const scope = this.scopesByRuntime.get(runtime);
		if (scope) this.disposeScope(scope);
	}

	/** Profile settings may inspect only unambiguous shared credentials. No profile
	 * read or mutation may choose between project providers that share an id. */
	createProfileCredentialStore(
		assertMutationAllowed: (providerId: string) => void = () => {},
		observeMutation?: PiStoredCredentialMutationObserver,
	): PiCredentialStore {
		const assertAllowed = (providerId: string): void => {
			this.assertProfileCredentialAccess(providerId);
			assertMutationAllowed(providerId);
		};
		return {
			read: async (providerId, options) => {
				throwIfOperationAborted(options?.signal);
				this.assertProfileCredentialAccess(providerId);
				const credential = await this.profileCredentials.read(providerId, options);
				throwIfOperationAborted(options?.signal);
				this.assertProfileCredentialAccess(providerId);
				return credential;
			},
			list: async (options) => {
				throwIfOperationAborted(options?.signal);
				const credentials = await this.profileCredentials.list(options);
				throwIfOperationAborted(options?.signal);
				return credentials.filter((entry) => !this.isProviderAmbiguousForProfile(entry.providerId));
			},
			modify: async (providerId, mutate, options) => {
				throwIfOperationAborted(options?.signal);
				assertAllowed(providerId);
				return await this.profileCredentials.modifyChecked(
					providerId,
					async (current) => {
						throwIfOperationAborted(options?.signal);
						assertAllowed(providerId);
						const next = await mutate(current);
						throwIfOperationAborted(options?.signal);
						// Provider login can wait on user input or the network while project
						// ownership or the models.json generation changes. Do not carry that
						// stale decision to auth.json.
						assertAllowed(providerId);
						return next;
					},
					() => assertAllowed(providerId),
					options,
					observeMutation,
				);
			},
			delete: async (providerId, options) => {
				throwIfOperationAborted(options?.signal);
				assertAllowed(providerId);
				await this.profileCredentials.deleteChecked(
					providerId,
					() => {
						assertAllowed(providerId);
					},
					options,
				);
			},
		};
	}

	async readStoredForProfile(providerId: string) {
		this.assertProfileCredentialAccess(providerId);
		const credential = await this.profileCredentials.readStored(providerId);
		this.assertProfileCredentialAccess(providerId);
		return credential;
	}

	deleteProfileCredentialSnapshot(
		providerId: string,
		assertMutationAllowed: () => void = () => {},
	): Promise<PiStoredCredentialSnapshot> {
		const assertAllowed = (): void => {
			this.assertProfileCredentialAccess(providerId);
			assertMutationAllowed();
		};
		assertAllowed();
		return this.profileCredentials.deleteSnapshotChecked(providerId, () => {
			assertAllowed();
		});
	}

	isProviderAmbiguous(runtime: ModelRuntime, providerId: string): boolean {
		const scope = this.scopesByRuntime.get(runtime);
		return scope ? this.isAmbiguous(scope, providerId) : false;
	}

	isProviderAmbiguousForProfile(providerId: string): boolean {
		return this.isAmbiguousAcrossProjects(providerId);
	}

	async readStoredForRuntime(runtime: ModelRuntime, providerId: string) {
		const scope = this.scopesByRuntime.get(runtime);
		if (!scope) throw new StalePiCredentialRuntimeError();
		this.assertCredentialAccess(scope, providerId);
		const credential = await this.profileCredentials.readStored(providerId);
		this.assertCredentialAccess(scope, providerId);
		return credential;
	}

	private createScopedStore(scope: RuntimeCredentialScope): PiCredentialStore {
		return {
			read: async (providerId, options) => {
				throwIfOperationAborted(options?.signal);
				this.assertActive(scope);
				if (this.isAmbiguous(scope, providerId)) {
					const stored = (await this.profileCredentials.list(options)).some((entry) => entry.providerId === providerId);
					throwIfOperationAborted(options?.signal);
					this.assertActive(scope);
					if (this.isAmbiguous(scope, providerId)) {
						if (stored) throw new AmbiguousPiProviderCredentialError(providerId);
						return undefined;
					}
				}
				const credential = await this.profileCredentials.read(providerId, options);
				throwIfOperationAborted(options?.signal);
				this.assertActive(scope);
				// A second cwd can register a colliding extension provider while the
				// profile read is waiting on auth.json's cross-process lock. Stored
				// credentials must still fail closed, but an absent stored entry must
				// remain absent so each provider's literal/env auth can stay local.
				if (this.isAmbiguous(scope, providerId)) {
					if (credential) throw new AmbiguousPiProviderCredentialError(providerId);
					return undefined;
				}
				return credential;
			},
			list: async (options) => {
				throwIfOperationAborted(options?.signal);
				this.assertActive(scope);
				const credentials = await this.profileCredentials.list(options);
				throwIfOperationAborted(options?.signal);
				this.assertActive(scope);
				return credentials.filter((entry) => !this.isAmbiguous(scope, entry.providerId));
			},
			modify: async (providerId, mutate, options) => {
				throwIfOperationAborted(options?.signal);
				this.assertCredentialAccess(scope, providerId);
				return await this.profileCredentials.modifyChecked(
					providerId,
					async (current) => {
						throwIfOperationAborted(options?.signal);
						this.assertCredentialAccess(scope, providerId);
						const next = await mutate(current);
						throwIfOperationAborted(options?.signal);
						// OAuth refresh/login may have waited on the network while the runtime
						// was replaced or another cwd registered a colliding provider.
						this.assertCredentialAccess(scope, providerId);
						return next;
					},
					() => this.assertCredentialAccess(scope, providerId),
					options,
				);
			},
			delete: async (providerId, options) => {
				throwIfOperationAborted(options?.signal);
				this.assertCredentialAccess(scope, providerId);
				await this.profileCredentials.deleteChecked(
					providerId,
					() => {
						this.assertCredentialAccess(scope, providerId);
					},
					options,
				);
			},
		};
	}

	private assertActive(scope: RuntimeCredentialScope): void {
		if (scope.disposed) throw new StalePiCredentialRuntimeError();
	}

	private assertCredentialAccess(scope: RuntimeCredentialScope, providerId: string): void {
		this.assertActive(scope);
		if (this.isAmbiguous(scope, providerId)) throw new AmbiguousPiProviderCredentialError(providerId);
	}

	private assertProfileCredentialAccess(providerId: string): void {
		if (this.disposed) throw new StalePiCredentialRuntimeError();
		if (this.isProviderAmbiguousForProfile(providerId)) throw new AmbiguousPiProviderCredentialError(providerId);
	}

	private isAmbiguous(scope: RuntimeCredentialScope, providerId: string): boolean {
		this.refreshAllProviderIds();
		if (!scope.effectiveProviderIds.has(providerId)) return false;
		return this.isAmbiguousAcrossRefreshedProjects(providerId);
	}

	private isAmbiguousAcrossProjects(providerId: string): boolean {
		this.refreshAllProviderIds();
		return this.isAmbiguousAcrossRefreshedProjects(providerId);
	}

	private isAmbiguousAcrossRefreshedProjects(providerId: string): boolean {
		let hasProjectOverride = false;
		for (const candidate of this.scopes) {
			if (
				!candidate.disposed &&
				candidate.registeredProviderIds.has(providerId) &&
				!candidate.userScopedProviderIds.has(providerId)
			) {
				hasProjectOverride = true;
				break;
			}
		}
		// Built-in, models.json, and user-scope (global package) providers intentionally
		// share profile credentials. Cwd ownership matters only once a project-scope
		// extension replaces that provider in at least one live project/runtime generation.
		if (!hasProjectOverride) return false;
		const cwdOwners = new Set<string>();
		for (const candidate of this.scopes) {
			if (candidate.disposed || !candidate.effectiveProviderIds.has(providerId)) continue;
			cwdOwners.add(candidate.cwd);
			if (cwdOwners.size > 1) return true;
		}
		return false;
	}

	private refreshAllProviderIds(): void {
		for (const scope of this.scopes) this.refreshProviderIds(scope);
	}

	private refreshProviderIds(scope: RuntimeCredentialScope): void {
		if (scope.disposed || !scope.runtime) return;
		scope.registeredProviderIds = new Set(scope.runtime.getRegisteredProviderIds());
		scope.effectiveProviderIds = new Set(scope.runtime.getProviders().map((provider) => provider.id));
	}

	private disposeScope(scope: RuntimeCredentialScope): void {
		if (scope.disposed) return;
		scope.disposed = true;
		scope.registeredProviderIds.clear();
		scope.effectiveProviderIds.clear();
		scope.userScopedProviderIds.clear();
		this.scopes.delete(scope);
		if (scope.runtime) this.scopesByRuntime.delete(scope.runtime);
		scope.runtime = null;
	}
}
