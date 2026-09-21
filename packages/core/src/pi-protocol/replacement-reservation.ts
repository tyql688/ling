interface PiWorkerReplacementReservationActions {
	commit(): void | Promise<void>;
	abort(): void | Promise<void>;
}

export interface PiWorkerReplacementReservation {
	readonly generation: number;
	readonly runtimeId: string;
	commit(): Promise<void>;
	abort(): Promise<void>;
}

type ReservationState = "pending" | "committing" | "committed" | "aborting" | "aborted";

function abortedReservationError(runtimeId: string): Error {
	return new Error(`Pi worker replacement reservation was already aborted for runtime: ${runtimeId}`);
}

export function createPiWorkerReplacementReservation(
	generation: number,
	runtimeId: string,
	actions: PiWorkerReplacementReservationActions,
): PiWorkerReplacementReservation {
	let state: ReservationState = "pending";
	let transition: Promise<void> | null = null;
	const requireTransition = (): Promise<void> => {
		if (!transition) throw new Error(`Pi worker replacement transition is missing for runtime: ${runtimeId}`);
		return transition;
	};

	const startAbort = (): Promise<void> => {
		state = "aborting";
		const work = Promise.resolve()
			.then(() => actions.abort())
			.finally(() => {
				state = "aborted";
			});
		transition = work;
		return work;
	};

	return {
		generation,
		runtimeId,
		commit() {
			if (state === "committing" || state === "committed") return requireTransition();
			if (state === "aborting" || state === "aborted") {
				return Promise.reject(abortedReservationError(runtimeId));
			}

			state = "committing";
			const work = Promise.resolve()
				.then(() => actions.commit())
				.then(
					() => {
						state = "committed";
					},
					async (commitError: unknown) => {
						state = "aborting";
						try {
							await actions.abort();
						} catch (abortError) {
							throw new AggregateError(
								[commitError, abortError],
								`Pi worker replacement commit and cleanup failed for runtime: ${runtimeId}`,
							);
						} finally {
							state = "aborted";
						}
						throw commitError;
					},
				);
			transition = work;
			return work;
		},
		abort() {
			if (state === "pending") return startAbort();
			if (state === "committing" || state === "aborting") return requireTransition();
			return Promise.resolve();
		},
	};
}
