export function waitForPiWorkerBarrier<Result>(
	barrier: Promise<Result>,
	signal: AbortSignal | undefined,
): Promise<Result> {
	if (!signal) return barrier;
	if (signal.aborted) {
		return Promise.reject(signal.reason ?? new Error("Pi worker request was cancelled before startup"));
	}
	return new Promise<Result>((resolve, reject) => {
		const onAbort = (): void => reject(signal.reason ?? new Error("Pi worker request was cancelled during startup"));
		signal.addEventListener("abort", onAbort, { once: true });
		void barrier.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}
