import { toError, type LingErrorCode, type LingErrorDto } from "@ling/contracts/ling-error";

export { toError };

export type LingError = Error & {
	code: LingErrorCode;
	lingError: LingErrorDto;
};

export function createLingError(dto: LingErrorDto, cause?: unknown): LingError {
	const error = cause === undefined ? new Error(dto.message) : new Error(dto.message, { cause });
	return Object.assign(error, { code: dto.code, lingError: dto });
}

export function isLingError(error: unknown): error is LingError {
	return (
		error instanceof Error &&
		"lingError" in error &&
		typeof error.lingError === "object" &&
		error.lingError !== null &&
		"code" in error.lingError &&
		typeof error.lingError.code === "string"
	);
}

/** Stable overload outcome for every bounded in-process admission queue. Keeping the
 * DTO construction here prevents individual domains from drifting to plain message
 * errors that renderer callers cannot distinguish or retry safely. */
export function requestCapacityExceeded(resource: string, capacity: number, message: string): LingError {
	return createLingError({
		code: "REQUEST_CAPACITY_EXCEEDED",
		category: "lifecycle",
		message,
		retryable: true,
		userAction: "retry",
		details: { resource, capacity },
	});
}

/** Rethrow cleanup failures: a single failure propagates as-is, several as one AggregateError. */
/** Runs a cleanup step that must not mask the failure being handled; collects instead of throwing. */
export function attemptCleanup(failures: unknown[], cleanup: () => void): void {
	try {
		cleanup();
	} catch (error) {
		failures.push(error);
	}
}

export function throwAggregateFailures(failures: readonly unknown[], message: string): void {
	if (failures.length === 1) throw failures[0];
	if (failures.length > 1) throw new AggregateError(failures, message);
}

/** Uniform REQUEST_CANCELLED outcome for shutdown/abort boundaries. */
export function requestCancelled(
	message: string,
	details?: Record<string, string | number | boolean | null>,
): LingError {
	return createLingError({
		code: "REQUEST_CANCELLED",
		category: "lifecycle",
		message,
		retryable: true,
		userAction: "retry",
		...(details ? { details } : {}),
	});
}

export function throwIfOperationAborted(signal: AbortSignal | undefined): void {
	if (!signal?.aborted) return;
	if (isLingError(signal.reason)) throw signal.reason;
	throw requestCancelled("The request was cancelled.");
}

/** Resolve an async boundary promptly when its owner is cancelled, even when an
 * upstream SDK callback only offers a Promise and cannot consume AbortSignal itself.
 * The original Promise remains observed so a late rejection never becomes unhandled. */
export function waitForOperation<T>(operation: T | PromiseLike<T>, signal: AbortSignal | undefined): Promise<T> {
	throwIfOperationAborted(signal);
	if (!signal) return Promise.resolve(operation);
	return new Promise<T>((resolve, reject) => {
		// The upstream Promise may ignore cancellation forever. Keep settlement functions
		// behind a mutable cell so abort can sever the late `.then` handler's strong link
		// to this already-rejected Promise and its caller graph.
		const state: {
			resolve: ((value: T) => void) | null;
			reject: ((error: unknown) => void) | null;
			signal: AbortSignal | null;
			onAbort: (() => void) | null;
		} = { resolve, reject, signal, onAbort: null };
		const cleanup = (): void => {
			if (state.onAbort && state.signal) state.signal.removeEventListener("abort", state.onAbort);
			state.onAbort = null;
			state.signal = null;
		};
		const takeSettlement = () => {
			const settlement = { resolve: state.resolve, reject: state.reject };
			state.resolve = null;
			state.reject = null;
			cleanup();
			return settlement;
		};
		state.onAbort = (): void => {
			const settlement = takeSettlement();
			if (!settlement.reject) return;
			try {
				throwIfOperationAborted(signal);
			} catch (error) {
				settlement.reject(error);
			}
		};
		signal.addEventListener("abort", state.onAbort, { once: true });
		if (signal.aborted) state.onAbort?.();
		Promise.resolve(operation).then(
			(value) => {
				const settlement = takeSettlement();
				settlement.resolve?.(value);
			},
			(error: unknown) => {
				const settlement = takeSettlement();
				settlement.reject?.(error);
			},
		);
	});
}
