import { attemptCleanup, requestCancelled, throwAggregateFailures } from "../../ling-error";

/** Cancels current waits while keeping later turns able to open new interactions. */
export function createExtensionUiInteractions() {
	let controller = new AbortController();
	let activeCancellations = 0;
	let closed = false;

	async function cancelWhile<T>(cancelPending: () => void, operation: () => Promise<T>): Promise<T> {
		activeCancellations += 1;
		controller.abort(requestCancelled("The session was stopped."));
		const failures: unknown[] = [];
		try {
			attemptCleanup(failures, cancelPending);
			// A panel disposal failure must not prevent Pi from aborting its model/tool work.
			const result = await Promise.resolve()
				.then(operation)
				.then(
					(value) => ({ status: "fulfilled", value }) as const,
					(reason: unknown) => ({ status: "rejected", reason }) as const,
				);
			if (result.status === "rejected") {
				failures.push(result.reason);
				throwAggregateFailures(failures, "Failed to stop session interactions and work");
				throw result.reason;
			}
			throwAggregateFailures(failures, "Failed to stop session interactions");
			return result.value;
		} finally {
			activeCancellations -= 1;
			// Concurrent stops must all drain before new dialogs are admitted. Shutdown
			// permanently closes this owner even if a stop was already in progress.
			if (activeCancellations === 0 && !closed) controller = new AbortController();
		}
	}

	return {
		get signal(): AbortSignal {
			controller.signal.throwIfAborted();
			return controller.signal;
		},
		cancelWhile,
		close(reason: Error): void {
			closed = true;
			controller.abort(reason);
		},
	};
}
