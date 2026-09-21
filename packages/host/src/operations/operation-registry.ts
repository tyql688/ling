import { createLingError, type LingError, requestCancelled } from "@ling/core/ling-error";
import {
	createOperationExecution,
	type OperationExecutionHandle,
	type OperationExecutionRecord,
} from "./operation-execution";

interface RegistryCoreOptions {
	maxDeadlineMs: number;
	/** Subject used in deadline error text, e.g. "request" / "plugin operation". */
	deadlineSubject: string;
	cancelledMessage: string;
}

interface CancelMismatch {
	code: "STALE_RUNTIME_GENERATION" | "STALE_STATE_REVISION";
	message: string;
}

interface RegistryCore<Record_ extends { execution: OperationExecutionRecord }> {
	begin(
		requestId: string,
		deadlineAt: number,
		makeRecord: (execution: OperationExecutionRecord) => Record_,
	): OperationExecutionHandle;
	cancelByRequest(
		requestId: string,
		matches: (record: Record_) => boolean,
		mismatch: CancelMismatch,
	): { requestId: string; accepted: boolean };
	cancelWhere(matches: (record: Record_) => boolean, reason: string): number;
}

export function ownerMismatchError(message: string): LingError {
	return createLingError({ code: "INVALID_REQUEST", category: "validation", message, retryable: false });
}

export function createOperationRegistry<Record_ extends { execution: OperationExecutionRecord }>(
	options: RegistryCoreOptions,
): RegistryCore<Record_> {
	const operations = new Map<string, Record_>();

	function cancellationError(reason: string): LingError {
		return requestCancelled(options.cancelledMessage, { reason });
	}

	function abort(record: Record_, reason: string): boolean {
		return record.execution.requestCancel(cancellationError(reason), Date.now());
	}

	return {
		begin(requestId, deadlineAt, makeRecord) {
			if (operations.has(requestId)) {
				throw createLingError({
					code: "REQUEST_ID_CONFLICT",
					category: "lifecycle",
					message: "The request id is already active.",
					retryable: false,
				});
			}
			const remainingMs = deadlineAt - Date.now();
			if (remainingMs <= 0) {
				throw createLingError({
					code: "REQUEST_DEADLINE_EXCEEDED",
					category: "lifecycle",
					message: `The ${options.deadlineSubject} deadline has expired.`,
					retryable: true,
					userAction: "retry",
				});
			}
			if (remainingMs > options.maxDeadlineMs) {
				throw createLingError({
					code: "INVALID_REQUEST",
					category: "validation",
					message: `The ${options.deadlineSubject} deadline exceeds the allowed window.`,
					retryable: false,
					details: { maxDeadlineMs: options.maxDeadlineMs },
				});
			}
			let record: Record_ | undefined;
			const execution = createOperationExecution({
				now: Date.now,
				remainingMs,
				deadlineError: createLingError({
					code: "REQUEST_DEADLINE_EXCEEDED",
					category: "lifecycle",
					message: `The ${options.deadlineSubject} deadline expired before completion.`,
					retryable: true,
					userAction: "retry",
				}),
				release() {
					if (record !== undefined && operations.get(requestId) === record) operations.delete(requestId);
				},
			});
			try {
				record = makeRecord(execution);
			} catch (error) {
				execution.finish(error);
				throw error;
			}
			operations.set(requestId, record);
			return execution;
		},
		cancelByRequest(requestId, matches, mismatch) {
			const record = operations.get(requestId);
			if (!record) return { requestId, accepted: false };
			if (!matches(record)) {
				throw createLingError({
					code: mismatch.code,
					category: "lifecycle",
					message: mismatch.message,
					retryable: false,
				});
			}
			return { requestId, accepted: abort(record, "caller") };
		},
		cancelWhere(matches, reason) {
			let count = 0;
			for (const record of operations.values()) {
				if (matches(record) && abort(record, reason)) count += 1;
			}
			return count;
		},
	};
}
