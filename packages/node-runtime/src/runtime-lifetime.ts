interface Cleanup {
	label: string;
	run(): void | Promise<void>;
}

/** Records ownership as resources are acquired, including partially constructed applications.
 * Admission stops synchronously; cleanup follows the composition root's explicit phase order.
 * Every cleanup runs even if an earlier owner fails, and repeated disposal shares its outcome. */
export function createRuntimeLifetime<Phase extends string>(phases: readonly Phase[]) {
	const stops: Array<{ label: string; run(): void }> = [];
	const cleanups = new Map<Phase, Cleanup[]>(phases.map((phase) => [phase, []]));
	const failures: Error[] = [];
	let stopped = false;
	let disposal: Promise<void> | null = null;

	function assertOpen(): void {
		if (stopped) throw new Error("Cannot acquire resources after runtime shutdown starts");
	}

	function recordFailure(label: string, error: unknown): void {
		console.error(`Failed to release ${label}:`, error);
		failures.push(new Error(`Failed to release ${label}`, { cause: error }));
	}

	function stop(): void {
		if (stopped) return;
		stopped = true;
		for (const cleanup of stops) {
			try {
				cleanup.run();
			} catch (error) {
				recordFailure(cleanup.label, error);
			}
		}
		stops.length = 0;
	}

	function dispose(): Promise<void> {
		if (disposal) return disposal;
		const settlement = Promise.withResolvers<void>();
		disposal = settlement.promise;
		stop();
		const drain = async (): Promise<void> => {
			for (const phase of phases) {
				const entries = cleanups.get(phase);
				if (!entries) throw new Error(`Unknown runtime cleanup phase: ${phase}`);
				for (const cleanup of entries) {
					try {
						await cleanup.run();
					} catch (error) {
						recordFailure(cleanup.label, error);
					}
				}
				entries.length = 0;
			}
			if (failures.length > 0) throw new AggregateError(failures, "Runtime shutdown failed");
		};
		void drain().then(settlement.resolve, settlement.reject);
		return disposal;
	}

	return {
		assertOpen,
		onStop(label: string, run: () => void): void {
			assertOpen();
			stops.push({ label, run });
		},
		defer(phase: Phase, label: string, run: Cleanup["run"]): void {
			assertOpen();
			const entries = cleanups.get(phase);
			if (!entries) throw new Error(`Unknown runtime cleanup phase: ${phase}`);
			entries.push({ label, run });
		},
		stop,
		dispose,
		async fail(error: unknown): Promise<never> {
			try {
				await dispose();
			} catch (cleanupError) {
				throw new AggregateError([error, cleanupError], "Runtime startup and rollback failed");
			}
			throw error;
		},
	};
}
