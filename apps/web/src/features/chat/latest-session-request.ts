interface LatestSessionRequestToken {
	revision: number;
	refKey: string;
}

interface LatestSessionRequestFence {
	begin(refKey: string): LatestSessionRequestToken;
	invalidate(): void;
	isCurrent(token: LatestSessionRequestToken, currentRefKey: string | null): boolean;
}

interface SessionMutationBarrier {
	track<Result>(refKey: string, operation: Promise<Result>): Promise<Result>;
	waitForCommittedMutations(refKey: string): Promise<void>;
}

type FailedSessionMutationReconciliation<State> =
	{ type: "stale" } | { type: "reconciled"; state: State } | { type: "readFailed" };

interface ReconcileFailedSessionMutationOptions<State> {
	refKey: string;
	request: LatestSessionRequestToken;
	requestFence: LatestSessionRequestFence;
	mutationBarrier: SessionMutationBarrier;
	currentRefKey(): string | null;
	readCommittedState(): Promise<State>;
}

/** One latest-wins fence shared by every async read and mutation for a
 * session-bound renderer value. A ref change and a newer request both make an
 * older result unusable before it reaches React state. */
export function createLatestSessionRequestFence(): LatestSessionRequestFence {
	let revision = 0;
	return {
		begin(refKey) {
			revision += 1;
			return { revision, refKey };
		},
		invalidate() {
			revision += 1;
		},
		isCurrent(token, currentRefKey) {
			return token.revision === revision && token.refKey === currentRefKey;
		},
	};
}

/** Tracks every renderer-initiated model mutation per session. Reads wait for
 * a stable settled tail, including mutations added while an earlier one is in
 * flight, so a refresh cannot project pre-mutation state as the latest value. */
export function createSessionMutationBarrier(): SessionMutationBarrier {
	const tails = new Map<string, Promise<void>>();
	return {
		track(refKey, operation) {
			const previous = tails.get(refKey) ?? Promise.resolve();
			const outcome = operation.then(
				() => undefined,
				() => undefined,
			);
			const tail = Promise.all([previous, outcome]).then(() => undefined);
			tails.set(refKey, tail);
			void tail.then(() => {
				if (tails.get(refKey) === tail) tails.delete(refKey);
			});
			return operation;
		},
		async waitForCommittedMutations(refKey) {
			while (true) {
				const tail = tails.get(refKey);
				if (!tail) return;
				await tail;
				if (tails.get(refKey) === tail) return;
			}
		},
	};
}

/** A failed latest mutation may follow an older mutation that did commit. Wait for
 * the complete mutation tail, then reconcile from the authoritative main-process
 * state without allowing a stale session/request to write back into React. */
export async function reconcileFailedSessionMutation<State>(
	options: ReconcileFailedSessionMutationOptions<State>,
): Promise<FailedSessionMutationReconciliation<State>> {
	await options.mutationBarrier.waitForCommittedMutations(options.refKey);
	if (!options.requestFence.isCurrent(options.request, options.currentRefKey())) return { type: "stale" };
	try {
		const state = await options.readCommittedState();
		if (!options.requestFence.isCurrent(options.request, options.currentRefKey())) return { type: "stale" };
		return { type: "reconciled", state };
	} catch {
		if (!options.requestFence.isCurrent(options.request, options.currentRefKey())) return { type: "stale" };
		return { type: "readFailed" };
	}
}
