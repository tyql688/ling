import type { OperationState } from "@ling/contracts/operation";
import { createLingError, type LingError, throwIfOperationAborted } from "@ling/core/ling-error";
import {
	classifyOperationFailure,
	cloneOperationState,
	createInitialOperationState,
	isOperationTerminal,
	reduceOperationState,
} from "@ling/host/operations/operation-state";

export interface OperationExecutionHandle {
	readonly signal: AbortSignal;
	getState(): OperationState;
	run<T>(operation: (signal: AbortSignal) => T | PromiseLike<T>): Promise<T>;
	finish(...errors: [] | [unknown]): void;
}

export interface OperationExecutionRecord extends OperationExecutionHandle {
	requestCancel(error: LingError, requestedAt: number): boolean;
}

interface CreateOperationExecutionOptions {
	now: () => number;
	remainingMs: number;
	deadlineError: LingError;
	release(): void;
}

/** Owns only canonical lifecycle transitions and timer cleanup. Feature registries still own
 * identity validation, record lookup, cancellation policy, and the concrete effect. */
export function createOperationExecution(options: CreateOperationExecutionOptions): OperationExecutionRecord {
	if (!Number.isSafeInteger(options.remainingMs) || options.remainingMs <= 0) {
		throw createLingError({
			code: "INVALID_REQUEST",
			category: "validation",
			message: "Operation execution remainingMs must be a positive safe integer.",
			retryable: false,
		});
	}
	const controller = new AbortController();
	let state = createInitialOperationState();
	let runStarted = false;
	let finished = false;
	let released = false;

	const timer = setTimeout(() => {
		if (isOperationTerminal(state)) return;
		state = reduceOperationState(state, classifyOperationFailure(options.deadlineError));
		if (!controller.signal.aborted) controller.abort(options.deadlineError);
		release();
	}, options.remainingMs);

	function release(): void {
		if (released) return;
		released = true;
		clearTimeout(timer);
		options.release();
	}

	const success = Symbol("operation-success");

	function settle(error: unknown): void {
		if (finished) return;
		finished = true;
		if (!isOperationTerminal(state)) {
			state = reduceOperationState(state, error === success ? { type: "succeed" } : classifyOperationFailure(error));
		}
		release();
	}

	function finish(...errors: [] | [unknown]): void {
		settle(errors.length === 0 ? success : errors[0]);
	}

	return {
		signal: controller.signal,
		getState: () => cloneOperationState(state),
		async run(operation) {
			if (runStarted || finished) {
				throw createLingError({
					code: "REQUEST_ID_CONFLICT",
					category: "lifecycle",
					message: "The operation execution handle can run only once.",
					retryable: false,
				});
			}
			runStarted = true;
			try {
				throwIfOperationAborted(controller.signal);
				state = reduceOperationState(state, { type: "start", startedAt: options.now() });
				const value = await operation(controller.signal);
				settle(success);
				return value;
			} catch (error) {
				settle(error);
				throw error;
			}
		},
		finish,
		requestCancel(error, requestedAt) {
			if (isOperationTerminal(state)) return false;
			state = reduceOperationState(state, { type: "requestCancel", requestedAt });
			if (!controller.signal.aborted) controller.abort(error);
			return true;
		},
	};
}
