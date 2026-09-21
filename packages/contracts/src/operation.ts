import type { LingErrorDto, LingErrorUserAction } from "./ling-error";

type OperationNonTerminalState =
	| { status: "queued" }
	| { status: "running"; startedAt: number }
	| { status: "waitingForApproval"; approvalRequestId: string }
	| { status: "cancelRequested"; requestedAt: number }
	| { status: "reconciling"; reason: string; attempt: number; deadlineAt: number };

export type OperationTerminalState =
	| { status: "succeeded" }
	| { status: "failed"; error: LingErrorDto }
	| { status: "cancelled" }
	| { status: "unknown"; reason: string; recoveryAction: LingErrorUserAction }
	| { status: "orphaned"; reason: string };

/** Canonical lifecycle state for Ling-owned long operations. */
export type OperationState = OperationNonTerminalState | OperationTerminalState;
