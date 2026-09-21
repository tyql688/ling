interface FeatureSnapshot<Value> {
	value: Value | null;
	error: unknown;
	busy: boolean;
}

/** Owns one feature scope; retired loads and actions cannot publish into its replacement. */
export function createFeatureSnapshot<Value>(load: () => Promise<Value>) {
	let snapshot: FeatureSnapshot<Value> = { value: null, error: null, busy: false };
	let active = false;
	let generation = 0;
	let sequence = 0;
	const listeners = new Set<() => void>();
	function publish(update: Partial<FeatureSnapshot<Value>>) {
		snapshot = { ...snapshot, ...update };
		for (const listener of listeners) listener();
	}
	async function refresh() {
		if (!active) return;
		const version = ++sequence;
		try {
			const value = await load();
			if (active && version === sequence) publish({ value, error: null });
		} catch (error) {
			if (active && version === sequence) publish({ error });
		}
	}
	return {
		getSnapshot: () => snapshot,
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		start() {
			active = true;
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
			publish({ busy: true, error: null });
			try {
				const result = await operation();
				if (!current()) return false;
				onSuccess?.(result);
				await refresh();
				return current();
			} catch (error) {
				if (current()) publish({ error });
				return false;
			} finally {
				if (current()) publish({ busy: false });
			}
		},
	};
}
