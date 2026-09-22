import { rethrowWithCleanup } from "./runtime-bound-resources";

interface RuntimeOperationCoordinatorOptions {
	assertCanStart(): void;
	getActiveReload(): Promise<void> | null;
	assertCanRunSynchronously(operation: string): void;
	onReleased(): void;
}

interface RuntimeOperationDrains {
	runtimeMutations: Promise<void> | null;
	runtimeOperations: Promise<void> | null;
}

export interface PiRuntimeOperationCoordinator {
	readonly activeCount: number;
	/** Operations that occupy the conversation; background metadata still owns a drain lease. */
	readonly foregroundCount: number;
	readonly activePromptCount: number;
	readonly pendingMutationCount: number;
	captureDrains(): RuntimeOperationDrains;
	run<Result>(run: () => Promise<Result>): Promise<Result>;
	runBackground<Result>(run: () => Promise<Result>): Promise<Result>;
	runPrompt<Result>(run: () => Promise<Result>): Promise<Result>;
	runOrderedMutation<Result>(run: () => Result | Promise<Result>): Promise<Result>;
	runSynchronously<Result>(operation: string, run: () => Result): Result;
}

export function createPiRuntimeOperationCoordinator(
	options: RuntimeOperationCoordinatorOptions,
): PiRuntimeOperationCoordinator {
	let activeOperations = 0;
	let backgroundOperations = 0;
	let activePromptOperations = 0;
	let operationsDrained: Promise<void> = Promise.resolve();
	let resolveOperationsDrained: (() => void) | null = null;
	let mutationTail: Promise<void> = Promise.resolve();
	let pendingMutations = 0;

	const claim = (background = false): void => {
		if (activeOperations === 0) {
			operationsDrained = new Promise((resolve) => {
				resolveOperationsDrained = resolve;
			});
		}
		activeOperations += 1;
		if (background) backgroundOperations += 1;
	};
	const release = (background = false): void => {
		activeOperations -= 1;
		if (background) backgroundOperations -= 1;
		if (activeOperations < 0) {
			throw new Error("Runtime operation count became negative");
		}
		if (activeOperations === 0) {
			const resolve = resolveOperationsDrained;
			resolveOperationsDrained = null;
			resolve?.();
		}
		options.onReleased();
	};
	const releasePrompt = (): void => {
		activePromptOperations -= 1;
		if (activePromptOperations < 0) {
			throw new Error("Prompt operation count became negative");
		}
	};
	const releasePendingMutation = (): void => {
		pendingMutations -= 1;
		if (pendingMutations < 0) {
			throw new Error("Runtime mutation count became negative");
		}
		options.onReleased();
	};
	const run = async <Result>(operation: () => Promise<Result>, background = false): Promise<Result> => {
		while (true) {
			options.assertCanStart();
			const reload = options.getActiveReload();
			if (reload) {
				await reload;
				continue;
			}
			claim(background);
			break;
		}
		const releaseOperation = () => release(background);
		return await Promise.resolve()
			.then(operation)
			.then(
				(result) => {
					releaseOperation();
					return result;
				},
				(error: unknown) =>
					rethrowWithCleanup(error, releaseOperation, "Runtime operation and its lease cleanup both failed"),
			);
	};

	return {
		get activeCount() {
			return activeOperations;
		},
		get foregroundCount() {
			return activeOperations - backgroundOperations;
		},
		get activePromptCount() {
			return activePromptOperations;
		},
		get pendingMutationCount() {
			return pendingMutations;
		},
		captureDrains() {
			return {
				runtimeMutations: pendingMutations > 0 ? mutationTail : null,
				runtimeOperations: activeOperations > 0 ? operationsDrained : null,
			};
		},
		run,
		runBackground: <Result>(operation: () => Promise<Result>) => run(operation, true),
		runPrompt<Result>(operation: () => Promise<Result>): Promise<Result> {
			return run(async () => {
				// Model selection may await credentials. A new prompt must not observe half-applied configuration.
				while (pendingMutations > 0) await mutationTail;
				activePromptOperations += 1;
				return Promise.resolve()
					.then(operation)
					.then(
						(result) => {
							releasePrompt();
							return result;
						},
						(error: unknown) =>
							rethrowWithCleanup(error, releasePrompt, "Prompt operation and its lease cleanup both failed"),
					);
			});
		},
		runOrderedMutation<Result>(operation: () => Result | Promise<Result>): Promise<Result> {
			// Model and thinking changes append entries to the same Pi session tree.
			// Preserve invocation order and keep queued work visible to reload/close.
			// Reject before joining the queue once disposal/replacement has fenced the
			// generation; `run()` repeats the check when this mutation reaches the head.
			options.assertCanStart();
			pendingMutations += 1;
			const queued = mutationTail.then(() => run(() => Promise.resolve(operation())));
			mutationTail = queued.then(
				() => undefined,
				() => undefined,
			);
			return queued.then(
				(result) => {
					releasePendingMutation();
					return result;
				},
				(error: unknown) =>
					rethrowWithCleanup(error, releasePendingMutation, "Runtime mutation and its queue cleanup both failed"),
			);
		},
		runSynchronously<Result>(operationName: string, operation: () => Result): Result {
			options.assertCanRunSynchronously(operationName);
			claim();
			let result: Result;
			try {
				result = operation();
			} catch (error) {
				return rethrowWithCleanup(error, release, "Synchronous runtime operation and its lease cleanup both failed");
			}
			release();
			return result;
		},
	};
}
