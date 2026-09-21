import { resolveMutationTargetSync } from "@ling/node-runtime/atomic-file";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { errorMessage } from "@ling/contracts/ling-error";
import { createAtomicFileStore, readUtf8FileSyncBoundedPreserveBom } from "@ling/core/store/atomic-file-store";
import { isDeepStrictEqual } from "node:util";
import type { PiStoredCredentialMutationObserver } from "./credential-store";
import { PI_MODELS_JSON_MAX_BYTES, piModelsJsonPath } from "./model-config-file";
import type { PiModelRuntimes } from "./model-runtime";
import {
	type ModelsJsonConfig,
	createEmptyModelsConfig,
	parseModelsConfig,
	serializeModelsConfig,
} from "./models-config-format";

export type StoredCredentialSnapshot = Awaited<ReturnType<PiModelRuntimes["deleteStoredProfileCredentialSnapshot"]>>;

interface ModelsConfigGeneration {
	publicationSource: string | undefined;
	targetPath: string;
}

interface ModelsConfigReadResult {
	config: ModelsJsonConfig;
	error: string | null;
	generation: ModelsConfigGeneration | null;
}

class PiModelRuntimeConfigError extends Error {
	constructor(readonly configError: string) {
		super(`Pi rejected models.json: ${configError}`);
		this.name = "PiModelRuntimeConfigError";
	}
}

export interface ModelsConfigMutation<Result> extends ModelsConfigGeneration {
	attempted: ModelsJsonConfig;
	attemptedSource: string;
	committed: boolean;
	previous: ModelsJsonConfig;
	previousSource: string | undefined;
	result: Result;
}

export class ModelsConfigGenerationChangedError extends Error {
	constructor(label: string) {
		super(`models.json changed while Ling attempted to ${label}; refresh the model catalog and retry`);
		this.name = "ModelsConfigGenerationChangedError";
	}
}

function modelsConfigGenerationChanged(label: string): ModelsConfigGenerationChangedError {
	return new ModelsConfigGenerationChangedError(label);
}

export function throwMutationFailures(failures: unknown[], message: string): never {
	if (failures.length === 1) throw failures[0];
	throw new AggregateError(failures, message);
}

export function createPiModelsConfig(modelRuntimes: PiModelRuntimes, agentDir: string) {
	const { getGlobalModelRuntime, replaceGlobalModelRuntime, restoreStoredProfileCredentialSnapshot } = modelRuntimes;

	const modelsConfigStore = createAtomicFileStore<ModelsJsonConfig>({
		getPath: () => piModelsJsonPath(agentDir),
		lockPath: "target",
		maxBytes: PI_MODELS_JSON_MAX_BYTES,
		create: createEmptyModelsConfig,
		parse: parseModelsConfig,
		serialize: serializeModelsConfig,
	});

	/** Pi refresh() reloads models.json before updating catalog/auth snapshots.
	 * Validate Ling's bounded JSONC/structure contract first so malformed external
	 * edits cannot replace an already published runtime generation. */
	async function refreshModelRuntime(
		runtime: ModelRuntime,
		options: Exclude<Parameters<ModelRuntime["refresh"]>[0], undefined>,
	): ReturnType<ModelRuntime["refresh"]> {
		try {
			await modelsConfigStore.read(options.signal ? { signal: options.signal } : {});
		} catch (error) {
			// Preserve Pi's refresh result contract when cancellation wins the
			// pre-validation read; callers should not receive a thrown validation error for
			// an operation they explicitly cancelled.
			if (options.signal?.aborted) return { aborted: true, errors: new Map() };
			throw error;
		}
		return runtime.refresh(options);
	}

	async function reloadGlobalModelRuntime(signal?: AbortSignal): Promise<ModelRuntime> {
		await modelsConfigStore.read(signal ? { signal } : {});
		return replaceGlobalModelRuntime({ ...(signal ? { signal } : {}), validate: assertUsableModelRuntime });
	}

	/** ModelRuntime combines configuration, composition, and availability errors in
	 * getError(). Recreate without the availability pass to isolate only errors that
	 * make the candidate configuration unusable; credential read failures remain a
	 * visible catalog error but must not be misreported as a rejected models.json. */
	async function assertUsableModelRuntime(runtime: ModelRuntime): Promise<void> {
		if (runtime.getError() === undefined) return;
		const configRuntime = await ModelRuntime.create({
			allowModelNetwork: false,
			modelsPath: piModelsJsonPath(agentDir),
			refreshOnCreate: false,
		});
		const configError = configRuntime.getError();
		if (configError !== undefined) throw new PiModelRuntimeConfigError(configError);
	}

	/** Catalog reads degrade to the last usable generation while still surfacing
	 * the rejected candidate's current configuration error. */
	async function reloadGlobalModelRuntimeForCatalog(generation: ModelsConfigGeneration): Promise<{
		runtime: ModelRuntime;
		configError: string | null;
	}> {
		try {
			const runtime = await replaceGlobalModelRuntime({
				validate: async (candidate) => {
					await assertModelsConfigGenerationCurrent("load the model catalog", generation);
					await assertUsableModelRuntime(candidate);
					await assertModelsConfigGenerationCurrent("load the model catalog", generation);
				},
			});
			// The candidate is published after validation. Detect an external writer in
			// that last cross-process window so the caller can rebuild from one generation.
			await assertModelsConfigGenerationCurrent("load the model catalog", generation);
			return { runtime, configError: null };
		} catch (error) {
			if (!(error instanceof PiModelRuntimeConfigError)) throw error;
			await assertModelsConfigGenerationCurrent("load the model catalog", generation);
			return { runtime: await getGlobalModelRuntime(), configError: error.configError };
		}
	}

	/**
	 * Custom providers' display names live only in models.json's `name` field. ModelRuntime
	 * validates and projects the provider catalog; this read supplies the custom names plus
	 * bounded-I/O and structural errors that must remain visible to Ling.
	 */
	async function readModelsConfigSafe(): Promise<ModelsConfigReadResult> {
		try {
			return await modelsConfigStore.transact((config, context) => ({
				commit: false,
				result: {
					config,
					error: null,
					generation: {
						publicationSource: context.source,
						targetPath: context.targetPath,
					},
				},
			}));
		} catch (error) {
			return {
				config: createEmptyModelsConfig(),
				error: errorMessage(error),
				generation: null,
			};
		}
	}

	/** Provider ids that ship with Pi — computed from a runtime that ignores models.json. */
	let builtInProviderIdsPromise: Promise<ReadonlySet<string>> | null = null;

	function getBuiltInProviderIds(): Promise<ReadonlySet<string>> {
		if (!builtInProviderIdsPromise) {
			const creation = ModelRuntime.create({ allowModelNetwork: false, modelsPath: null }).then(
				(runtime) => new Set(runtime.getProviders().map((provider) => provider.id)),
			);
			builtInProviderIdsPromise = creation;
			void creation.catch(() => {
				if (builtInProviderIdsPromise === creation) builtInProviderIdsPromise = null;
			});
		}
		return builtInProviderIdsPromise;
	}

	function commitModelsConfigMutation<Result>(
		mutate: (config: ModelsJsonConfig) => Result | Promise<Result>,
		backupBeforeCommit?: (source: string, targetPath: string) => Promise<void>,
	): Promise<ModelsConfigMutation<Result>> {
		return modelsConfigStore.transact(async (config, context) => {
			const previous = structuredClone(config);
			const result = await mutate(config);
			const attemptedSource = serializeModelsConfig(config);
			const committed = !isDeepStrictEqual(config, previous);
			// A candidate that this store cannot read must never reach disk: otherwise
			// the compensating transaction would fail while parsing the bad candidate
			// before it had a chance to restore the previous source.
			parseModelsConfig(attemptedSource, context.targetPath);
			if (committed && backupBeforeCommit && context.source !== undefined) {
				await backupBeforeCommit(context.source, context.targetPath);
			}
			const transaction: ModelsConfigMutation<Result> = {
				attempted: structuredClone(config),
				attemptedSource,
				committed,
				publicationSource: committed ? attemptedSource : context.source,
				previous,
				previousSource: context.source,
				targetPath: context.targetPath,
				result,
			};
			return { commit: committed, result: transaction };
		});
	}

	function assertModelsConfigGenerationCurrentSync(label: string, generation: ModelsConfigGeneration): void {
		const configuredPath = piModelsJsonPath(agentDir);
		const targetBeforeRead = resolveMutationTargetSync(configuredPath);
		if (targetBeforeRead !== generation.targetPath) throw modelsConfigGenerationChanged(label);
		const source = readUtf8FileSyncBoundedPreserveBom(generation.targetPath, PI_MODELS_JSON_MAX_BYTES);
		const targetAfterRead = resolveMutationTargetSync(configuredPath);
		if (targetAfterRead !== generation.targetPath || source !== generation.publicationSource) {
			throw modelsConfigGenerationChanged(label);
		}
	}

	function assertModelsConfigGenerationCurrent(label: string, generation: ModelsConfigGeneration): Promise<void> {
		return modelsConfigStore.transact((_config, context) => {
			if (context.targetPath !== generation.targetPath || context.source !== generation.publicationSource) {
				throw modelsConfigGenerationChanged(label);
			}
			return { commit: false, result: undefined };
		});
	}

	function assertModelsConfigMutationCurrentSync<Result>(
		label: string,
		transaction: ModelsConfigMutation<Result>,
	): void {
		assertModelsConfigGenerationCurrentSync(label, transaction);
	}

	function assertModelsConfigMutationCurrent<Result>(
		label: string,
		transaction: ModelsConfigMutation<Result>,
	): Promise<void> {
		return assertModelsConfigGenerationCurrent(label, transaction);
	}

	async function reloadGlobalModelRuntimeForMutation<Result>(
		label: string,
		transaction: ModelsConfigMutation<Result>,
		observeCredentialMutation?: PiStoredCredentialMutationObserver,
	): Promise<ModelRuntime> {
		const assertCurrent = (): void => assertModelsConfigMutationCurrentSync(label, transaction);
		const runtime = await replaceGlobalModelRuntime({
			assertCredentialMutationAllowed: assertCurrent,
			...(observeCredentialMutation ? { observeCredentialMutation } : {}),
			validate: async (candidate) => {
				await assertModelsConfigMutationCurrent(label, transaction);
				await assertUsableModelRuntime(candidate);
				await assertModelsConfigMutationCurrent(label, transaction);
			},
		});
		// The validation hook runs before publication. Recheck once after publication so
		// a concurrent editor cannot make Ling report this mutation against another file generation.
		await assertModelsConfigMutationCurrent(label, transaction);
		return runtime;
	}

	/** Restores only this transaction's exact publication. A semantic restore made
	 * by another writer is left untouched and returns false. */
	function restoreModelsConfigMutation<Result>(
		label: string,
		transaction: ModelsConfigMutation<Result>,
	): Promise<boolean> {
		if (!transaction.committed) return Promise.resolve(false);
		return modelsConfigStore.transact((config, context) => {
			if (isDeepStrictEqual(config, transaction.previous)) return { commit: false, result: false };
			if (
				context.targetPath !== transaction.targetPath ||
				!isDeepStrictEqual(config, transaction.attempted) ||
				context.source !== transaction.attemptedSource
			) {
				throw new Error(`${label} changed before rollback`);
			}
			// A rejected mutation must not erase comments, a BOM, or hand-written
			// formatting. Null restores the original absence instead of creating an empty file.
			return {
				commit: true,
				result: true,
				serializedContents: transaction.previousSource ?? null,
			};
		});
	}

	/** Credential compensation may restore a previous secret only when the exact
	 * models.json generation that owned it is current again. Run this synchronously
	 * inside auth.json's transaction lock so no await separates the ownership check
	 * from choosing the compensating credential value. */
	function isPreviousModelsConfigGenerationCurrentSync<Result>(transaction: ModelsConfigMutation<Result>): boolean {
		const configuredPath = piModelsJsonPath(agentDir);
		const targetBeforeRead = resolveMutationTargetSync(configuredPath);
		if (targetBeforeRead !== transaction.targetPath) return false;
		const source = readUtf8FileSyncBoundedPreserveBom(transaction.targetPath, PI_MODELS_JSON_MAX_BYTES);
		const targetAfterRead = resolveMutationTargetSync(configuredPath);
		return targetAfterRead === transaction.targetPath && source === transaction.previousSource;
	}

	/** Restore an auth.json snapshot only while the models.json generation that owned
	 * it is current. Recheck after the asynchronous auth publication and remove the
	 * exact restored value if models.json changed during that cross-file window. */
	async function restoreCredentialForModelsRollback<Result>(
		provider: string,
		transaction: ModelsConfigMutation<Result>,
		attempted: StoredCredentialSnapshot,
		previous: StoredCredentialSnapshot,
	): Promise<StoredCredentialSnapshot> {
		const ownershipCheck = { failed: false, error: undefined as unknown };
		const restored = await restoreStoredProfileCredentialSnapshot(provider, attempted, () => {
			if (!previous.exists) return previous;
			try {
				return isPreviousModelsConfigGenerationCurrentSync(transaction) ? previous : { exists: false };
			} catch (error) {
				// Unknown ownership must fail closed. Delete only this transaction's exact
				// attempted value, then surface the models.json read failure to the caller.
				ownershipCheck.failed = true;
				ownershipCheck.error = error;
				return { exists: false };
			}
		});
		if (ownershipCheck.failed) throw ownershipCheck.error;
		if (!restored.exists || !previous.exists) return restored;

		let postPublicationFailure: { error: unknown } | null = null;
		let previousGenerationCurrent = false;
		try {
			previousGenerationCurrent = isPreviousModelsConfigGenerationCurrentSync(transaction);
		} catch (error) {
			postPublicationFailure = { error };
		}
		if (previousGenerationCurrent) return restored;

		const cleanupFailures: unknown[] = postPublicationFailure ? [postPublicationFailure.error] : [];
		let removed: StoredCredentialSnapshot = restored;
		try {
			removed = await restoreStoredProfileCredentialSnapshot(provider, restored, { exists: false });
		} catch (error) {
			cleanupFailures.push(error);
		}
		if (cleanupFailures.length > 0) {
			throwMutationFailures(
				cleanupFailures,
				`Failed to verify models.json ownership and remove the restored credential for provider "${provider}"`,
			);
		}
		return removed;
	}

	async function reloadCurrentModelRuntimeAfterFailure(failures: unknown[]): Promise<void> {
		try {
			await reloadGlobalModelRuntime();
		} catch (error) {
			failures.push(error);
		}
	}

	async function mutateModelsConfigAndReload<Result>(
		label: string,
		mutate: (config: ModelsJsonConfig) => Result | Promise<Result>,
		backupBeforeCommit?: (source: string, targetPath: string) => Promise<void>,
	): Promise<Result> {
		const transaction = await commitModelsConfigMutation(mutate, backupBeforeCommit);
		try {
			await reloadGlobalModelRuntimeForMutation(label, transaction);
			return transaction.result;
		} catch (error) {
			const failures: unknown[] = [error];
			try {
				await restoreModelsConfigMutation(label, transaction);
			} catch (rollbackError) {
				failures.push(rollbackError);
			}
			await reloadCurrentModelRuntimeAfterFailure(failures);
			throwMutationFailures(failures, `Failed to ${label}, restore models.json, and synchronize the model runtime`);
		}
	}
	return {
		refreshModelRuntime,
		reloadGlobalModelRuntime,
		reloadGlobalModelRuntimeForCatalog,
		readModelsConfigSafe,
		getBuiltInProviderIds,
		commitModelsConfigMutation,
		assertModelsConfigMutationCurrentSync,
		assertModelsConfigMutationCurrent,
		reloadGlobalModelRuntimeForMutation,
		restoreModelsConfigMutation,
		restoreCredentialForModelsRollback,
		reloadCurrentModelRuntimeAfterFailure,
		mutateModelsConfigAndReload,
		modelsConfigStore,
	};
}

export type PiModelsConfig = ReturnType<typeof createPiModelsConfig>;
