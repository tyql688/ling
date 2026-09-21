import { requestCancelled } from "@ling/core/ling-error";

function shutdownCancellationError() {
	return requestCancelled("The Pi settings update was cancelled because Ling is shutting down.");
}

export function createPiSettingsMutations() {
	let mutationTail: Promise<void> = Promise.resolve();
	let shutdownPromise: Promise<void> | null = null;
	let shuttingDown = false;

	/**
	 * One in-process owner for every mutation of Pi's global settings.json. Filesystem
	 * locking still coordinates with Pi CLI and other Ling processes; this queue also
	 * gives Ling mutations deterministic ordering and keeps runtime side effects paired
	 * with the write that caused them.
	 */
	function enqueueGlobalSettingsMutation<Result>(mutate: () => Promise<Result>): Promise<Result> {
		if (shuttingDown) return Promise.reject(shutdownCancellationError());
		const operation = mutationTail.then(mutate);
		mutationTail = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}

	/** Stops admitting global settings writes and drains every update accepted before
	 * application shutdown. The application shutdown coordinator owns the outer deadline. */
	function shutdownGlobalSettingsMutations(): Promise<void> {
		if (shutdownPromise) return shutdownPromise;
		shuttingDown = true;
		shutdownPromise = mutationTail;
		return shutdownPromise;
	}
	return { enqueueGlobalSettingsMutation, shutdownGlobalSettingsMutations };
}

export type PiSettingsMutations = ReturnType<typeof createPiSettingsMutations>;
