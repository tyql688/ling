import type {
	CancelChangeReviewDiffRequest,
	CancelChangeReviewDiffResponse,
	ChangeReviewDiffRequest,
} from "@ling/contracts/git";
import type { SessionRef } from "@ling/contracts/session";
import { CHANGE_REVIEW_DIFF_OWNER_ID, isBuiltinOperationRef, sameOperationRef } from "@ling/contracts/owner-ref";
import { sessionKey } from "@ling/contracts/session-ref";
import { pathIdentity } from "@ling/core/paths";
import type { OperationExecutionHandle, OperationExecutionRecord } from "../../operations/operation-execution";

import { createOperationRegistry, ownerMismatchError } from "../../operations/operation-registry";

// ── Change-review diff (bound to session + snapshotId) ────────────────────────

/**
 * Max deadline for a change-review diff operation. A single-file diff is usually
 * seconds; 60s covers large patches — cancel on timeout so the UI stops spinning and
 * the Git write queue is not held.
 */
const CHANGE_REVIEW_MAX_DEADLINE_MS = 60_000;

interface DiffOperationRecord {
	operation: ChangeReviewDiffRequest["operation"];
	ref: SessionRef;
	snapshotId: string;
	execution: OperationExecutionRecord;
}

export interface ChangeReviewOperationRegistry {
	start(request: ChangeReviewDiffRequest): OperationExecutionHandle;
	cancel(request: CancelChangeReviewDiffRequest): CancelChangeReviewDiffResponse;
	cancelByRef(ref: SessionRef, reason: string): number;
	cancelByProject(cwd: string, reason: string): number;
	cancelAll(reason: string): number;
}

export function createChangeReviewOperationRegistry(): ChangeReviewOperationRegistry {
	const core = createOperationRegistry<DiffOperationRecord>({
		maxDeadlineMs: CHANGE_REVIEW_MAX_DEADLINE_MS,
		deadlineSubject: "change review diff",
		cancelledMessage: "The change review diff request was cancelled.",
	});
	return {
		start(request) {
			const expected = {
				scope: { kind: "session" as const, ref: request.ref },
				revision: request.snapshotId,
				generation: 0,
			};
			if (!isBuiltinOperationRef(request.operation, CHANGE_REVIEW_DIFF_OWNER_ID, expected)) {
				throw ownerMismatchError("The change review operation owner does not match its snapshot binding.");
			}
			return core.begin(request.operation.requestId, request.deadlineAt, (execution) => ({
				operation: request.operation,
				ref: { ...request.ref },
				snapshotId: request.snapshotId,
				execution,
			}));
		},
		cancel(request) {
			return core.cancelByRequest(
				request.operation.requestId,
				(record) =>
					sameOperationRef(record.operation, request.operation) &&
					sessionKey(record.ref) === sessionKey(request.ref) &&
					record.snapshotId === request.snapshotId,
				{ code: "STALE_STATE_REVISION", message: "The cancellation target does not own this change review request." },
			);
		},
		cancelByRef(ref, reason) {
			const key = sessionKey(ref);
			return core.cancelWhere((record) => sessionKey(record.ref) === key, reason);
		},
		cancelByProject: (cwd, reason) =>
			core.cancelWhere((record) => pathIdentity(record.ref.cwd) === pathIdentity(cwd), reason),
		cancelAll: (reason) => core.cancelWhere(() => true, reason),
	};
}
