import type { OperationState, OperationTerminalState } from "@ling/contracts/operation";
import type { LingErrorDto, LingErrorUserAction } from "@ling/contracts/ling-error";
import { hasControlCharacter } from "@ling/contracts/text-validation";
import { createLingError, isLingError } from "@ling/core/ling-error";

/**
 * Limit for human-readable fields (reason, etc.) in the operation state machine. 256 covers
 * diagnostic sentences and keeps abnormal strings out of state.
 */
const MAX_OPERATION_TEXT_LENGTH = 256;
/**
 * Limit for operation id / approvalRequestId and similar identifiers. 128 covers UUIDs and short tokens.
 */
const MAX_OPERATION_ID_LENGTH = 128;

type OperationTransition =
	| { type: "start"; startedAt: number }
	| { type: "waitForApproval"; approvalRequestId: string }
	| { type: "requestCancel"; requestedAt: number }
	| { type: "reconcile"; reason: string; attempt: number; deadlineAt: number }
	| { type: "succeed" }
	| { type: "fail"; error: LingErrorDto }
	| { type: "confirmCancelled" }
	| { type: "markUnknown"; reason: string; recoveryAction: LingErrorUserAction }
	| { type: "markOrphaned"; reason: string };

export function createInitialOperationState(): OperationState {
	return { status: "queued" };
}

export function isOperationTerminal(state: OperationState): state is OperationTerminalState {
	return (
		state.status === "succeeded" ||
		state.status === "failed" ||
		state.status === "cancelled" ||
		state.status === "unknown" ||
		state.status === "orphaned"
	);
}

export function cloneOperationState(state: OperationState): OperationState {
	return structuredClone(state);
}

function transitionError(state: OperationState, transition: OperationTransition) {
	return createLingError({
		code: isOperationTerminal(state) ? "STALE_STATE_REVISION" : "INVALID_REQUEST",
		category: "lifecycle",
		message: isOperationTerminal(state)
			? `Operation terminal state ${state.status} cannot transition to ${transition.type}.`
			: `Operation state ${state.status} cannot transition to ${transition.type}.`,
		retryable: false,
	});
}

function assertAllowed(
	state: OperationState,
	transition: OperationTransition,
	allowed: readonly OperationState["status"][],
) {
	if (!allowed.includes(state.status)) throw transitionError(state, transition);
}

function assertTimestamp(value: number, label: string): number {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw createLingError({
			code: "INVALID_REQUEST",
			category: "validation",
			message: `${label} must be a non-negative safe integer.`,
			retryable: false,
		});
	}
	return value;
}

function assertText(value: string, label: string, maxLength: number): string {
	if (value.length === 0 || value.length > maxLength || value.trim() !== value || hasControlCharacter(value)) {
		throw createLingError({
			code: "INVALID_REQUEST",
			category: "validation",
			message: `${label} must be a normalized non-empty string of at most ${maxLength} characters.`,
			retryable: false,
		});
	}
	return value;
}

export function reduceOperationState(state: OperationState, transition: OperationTransition): OperationState {
	if (isOperationTerminal(state)) throw transitionError(state, transition);

	switch (transition.type) {
		case "start":
			assertAllowed(state, transition, ["queued", "waitingForApproval"]);
			return { status: "running", startedAt: assertTimestamp(transition.startedAt, "startedAt") };
		case "waitForApproval":
			assertAllowed(state, transition, ["queued", "running"]);
			return {
				status: "waitingForApproval",
				approvalRequestId: assertText(transition.approvalRequestId, "approvalRequestId", MAX_OPERATION_ID_LENGTH),
			};
		case "requestCancel":
			if (state.status === "cancelRequested") return { ...state };
			assertAllowed(state, transition, ["queued", "running", "waitingForApproval", "reconciling"]);
			return { status: "cancelRequested", requestedAt: assertTimestamp(transition.requestedAt, "requestedAt") };
		case "reconcile": {
			assertAllowed(state, transition, ["queued", "running", "waitingForApproval", "cancelRequested", "reconciling"]);
			if (!Number.isSafeInteger(transition.attempt) || transition.attempt <= 0) {
				throw createLingError({
					code: "INVALID_REQUEST",
					category: "validation",
					message: "Reconciliation attempt must be a positive safe integer.",
					retryable: false,
				});
			}
			const deadlineAt = assertTimestamp(transition.deadlineAt, "deadlineAt");
			if (state.status === "reconciling") {
				if (transition.attempt <= state.attempt || deadlineAt > state.deadlineAt) {
					throw createLingError({
						code: "STALE_STATE_REVISION",
						category: "lifecycle",
						message: "Reconciliation must advance its attempt without extending its deadline.",
						retryable: false,
					});
				}
			}
			return {
				status: "reconciling",
				reason: assertText(transition.reason, "reconciliation reason", MAX_OPERATION_TEXT_LENGTH),
				attempt: transition.attempt,
				deadlineAt,
			};
		}
		case "succeed":
			assertAllowed(state, transition, ["queued", "running", "cancelRequested", "reconciling"]);
			return { status: "succeeded" };
		case "fail":
			return { status: "failed", error: structuredClone(transition.error) };
		case "confirmCancelled":
			return { status: "cancelled" };
		case "markUnknown":
			return {
				status: "unknown",
				reason: assertText(transition.reason, "unknown-state reason", MAX_OPERATION_TEXT_LENGTH),
				recoveryAction: transition.recoveryAction,
			};
		case "markOrphaned":
			return {
				status: "orphaned",
				reason: assertText(transition.reason, "orphan reason", MAX_OPERATION_TEXT_LENGTH),
			};
	}
}

export function classifyOperationFailure(error: unknown): OperationTransition {
	if (isLingError(error)) {
		if (error.lingError.code === "REQUEST_CANCELLED") return { type: "confirmCancelled" };
		return { type: "fail", error: structuredClone(error.lingError) };
	}
	return {
		type: "fail",
		error: {
			code: "INTERNAL_ERROR",
			category: "runtime",
			message: "The operation failed.",
			retryable: false,
			userAction: "report",
		},
	};
}
