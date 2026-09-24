interface FeatureSnapshot<Value> {
	value: Value | null;
	error: unknown;
	busy: boolean;
}

/** Owns one feature scope; retired loads and actions cannot publish into its replacement. */
export function createFeatureSnapshot<Value>(load: () => Promise<Value>) {
	let snapshot: FeatureSnapshot<Value> = { value: null, error: null, busy: false };
	let active = false;
	let mutating = false;
	let generation = 0;
	let sequence = 0;
	const listeners = new Set<() => void>();
	function publish(update: Partial<FeatureSnapshot<Value>>) {
		snapshot = { ...snapshot, ...update };
		for (const listener of listeners) listener();
	}
	async function loadSnapshot(preserveError = false) {
		if (!active) return;
		const version = ++sequence;
		try {
			const value = await load();
			if (active && version === sequence) publish({ value, ...(!preserveError && { error: null }) });
		} catch (error) {
			if (active && version === sequence)
				publish({
					error:
						preserveError && snapshot.error !== null
							? new AggregateError([snapshot.error, error], "Feature change and refresh failed")
							: error,
				});
		}
	}
	async function refresh() {
		// Change events emitted by an action are reconciled once after it settles.
		if (!mutating) await loadSnapshot(snapshot.busy && snapshot.error !== null);
	}
	return {
		getSnapshot: () => snapshot,
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		start() {
			active = true;
			mutating = false;
			publish({ busy: false });
			return () => {
				active = false;
				generation++;
				sequence++;
			};
		},
		refresh,
		async act<Result>(operation: () => Promise<Result>, onSuccess?: (result: Result) => void): Promise<boolean> {
			if (!active || snapshot.busy) return false;
			const started = generation;
			const current = () => active && started === generation;
			mutating = true;
			// A pre-mutation read cannot replace the action's result or failure.
			sequence++;
			publish({ busy: true, error: null });
			let succeeded = false;
			try {
				const result = await operation();
				if (!current()) return false;
				onSuccess?.(result);
				succeeded = true;
			} catch (error) {
				if (current()) publish({ error });
			} finally {
				if (current()) {
					mutating = false;
					// Failed mutations may have persisted part of their change.
					await loadSnapshot(!succeeded);
					if (current()) publish({ busy: false });
				}
			}
			return succeeded && current();
		},
	};
}
