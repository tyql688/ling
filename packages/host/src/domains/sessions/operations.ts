import type {
	CancelSessionOperationRequest,
	CancelSessionOperationResponse,
	ReadTranscriptPageRequest,
	SessionRef,
} from "@ling/contracts/session";
import { isBuiltinSessionOperationRef, sameOperationRef, SESSION_TRANSCRIPT_OWNER_ID } from "@ling/contracts/owner-ref";
import { sessionKey } from "@ling/contracts/session-ref";
import { pathIdentity } from "@ling/core/paths";
import type { OperationExecutionHandle, OperationExecutionRecord } from "../../operations/operation-execution";

import { createOperationRegistry, ownerMismatchError } from "../../operations/operation-registry";
// ── Session operations (transcript paging / completion etc., bound to runtimeId + generation) ──

/**
 * Max deadline span for session-class cancellable operations (transcript
 * paging/completion). 5min covers big pages on slow disks; longer caller values are
 * clamped to this cap so no operation hangs without ever timing out.
 */
const SESSION_MAX_DEADLINE_MS = 5 * 60 * 1000;

type SessionOperationRequest = Pick<
	ReadTranscriptPageRequest,
	"operation" | "ref" | "runtimeId" | "generation" | "deadlineAt"
>;

interface SessionOperationRecord extends SessionOperationRequest {
	execution: OperationExecutionRecord;
}

interface SessionOperationRegistry {
	start(request: SessionOperationRequest, expectedOwnerId?: string): OperationExecutionHandle;
	cancel(request: CancelSessionOperationRequest): CancelSessionOperationResponse;
	cancelByRef(ref: SessionRef, reason: string): number;
	cancelByProject(cwd: string, reason: string): number;
	cancelAll(reason: string): number;
}

export function createSessionOperationRegistry(): SessionOperationRegistry {
	const core = createOperationRegistry<SessionOperationRecord>({
		maxDeadlineMs: SESSION_MAX_DEADLINE_MS,
		deadlineSubject: "request",
		cancelledMessage: "The request was cancelled.",
	});
	return {
		start(request, expectedOwnerId = SESSION_TRANSCRIPT_OWNER_ID) {
			if (!isBuiltinSessionOperationRef(request.operation, expectedOwnerId, request.ref, request.generation)) {
				throw ownerMismatchError("The session operation owner does not match its runtime binding.");
			}
			return core.begin(request.operation.requestId, request.deadlineAt, (execution) => ({
				...request,
				operation: {
					requestId: request.operation.requestId,
					owner: {
						...request.operation.owner,
						scope:
							request.operation.owner.scope.kind === "project"
								? { kind: "project", ref: { ...request.operation.owner.scope.ref } }
								: request.operation.owner.scope.kind === "session"
									? { kind: "session", ref: { ...request.operation.owner.scope.ref } }
									: request.operation.owner.scope,
					},
				},
				ref: { ...request.ref },
				execution,
			}));
		},
		cancel(request) {
			return core.cancelByRequest(
				request.operation.requestId,
				(record) =>
					sameOperationRef(record.operation, request.operation) &&
					sessionKey(record.ref) === sessionKey(request.ref) &&
					record.runtimeId === request.runtimeId &&
					record.generation === request.generation,
				{ code: "STALE_RUNTIME_GENERATION", message: "The cancellation target does not own this request." },
			);
		},
		cancelByRef(ref, reason) {
			const key = sessionKey(ref);
			return core.cancelWhere((record) => sessionKey(record.ref) === key, reason);
		},
		// Project close uses the canonical open-project path; match refs by path identity
		// so Windows case aliases still cancel.
		cancelByProject: (cwd, reason) =>
			core.cancelWhere((record) => pathIdentity(record.ref.cwd) === pathIdentity(cwd), reason),
		cancelAll: (reason) => core.cancelWhere(() => true, reason),
	};
}
