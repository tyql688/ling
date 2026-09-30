type PersistedSettingsMutationResult<Success, Persisted> =
	| { status: "saved"; value: Success }
	| {
			status: "failed";
			error: unknown;
			persisted: { status: "ready"; value: Persisted } | { status: "unavailable"; error: unknown };
	  };

/** A Host mutation can persist successfully and still reject because live
 * Pi generations failed to reload. Always read the canonical saved value after a
 * rejection so the settings UI never keeps presenting a stale pre-save snapshot. */
async function runPersistedSettingsMutation<Success, Persisted>(
	mutate: () => Promise<Success>,
	readPersisted: () => Promise<Persisted>,
): Promise<PersistedSettingsMutationResult<Success, Persisted>> {
	try {
		return { status: "saved", value: await mutate() };
	} catch (error) {
		try {
			return { status: "failed", error, persisted: { status: "ready", value: await readPersisted() } };
		} catch (readError) {
			return { status: "failed", error, persisted: { status: "unavailable", error: readError } };
		}
	}
}

interface PersistedSettingsMutationQueue {
	run<Success, Persisted>(
		mutate: () => Promise<Success>,
		readPersisted: () => Promise<Persisted>,
	): Promise<{ revision: number; result: PersistedSettingsMutationResult<Success, Persisted> }>;
	isCurrent(revision: number): boolean;
	invalidate(): void;
}

/** Serializes global settings writes and lets the renderer publish only the newest
 * requested snapshot. Host already serializes disk writes; this closes the separate
 * response-order window in React, including canonical reads after reload failures. */
export function createPersistedSettingsMutationQueue(): PersistedSettingsMutationQueue {
	let latestRevision = 0;
	let tail: Promise<void> = Promise.resolve();
	return {
		run(mutate, readPersisted) {
			latestRevision += 1;
			const revision = latestRevision;
			const operation = tail.then(() => runPersistedSettingsMutation(mutate, readPersisted));
			tail = operation.then(
				() => undefined,
				() => undefined,
			);
			return operation.then((result) => ({ revision, result }));
		},
		isCurrent(revision) {
			return revision === latestRevision;
		},
		invalidate() {
			latestRevision += 1;
		},
	};
}
