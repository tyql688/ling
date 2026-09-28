import { useDomainApi } from "@renderer/lib/host-api-context";
import type { ApprovalRequest } from "@ling/contracts/session";
import type { SessionRef } from "@ling/contracts/session-ref";
import { sameSessionRef } from "@ling/contracts/session-ref";
import { pendingApprovalQueueAtom } from "@renderer/features/sessions/state/session";
import { removeDialogRequest } from "@renderer/lib/dialog-request-replay";
import { useAtom } from "jotai";
import { useCallback, useMemo } from "react";

function approvalRequestsForSession(queue: readonly ApprovalRequest[], ref: SessionRef | null): ApprovalRequest[] {
	return ref === null ? [] : queue.filter((request) => !request.sessionStarting && sameSessionRef(request.ref, ref));
}

export function useApproval(ref: SessionRef | null) {
	const hostSessionApi = useDomainApi("session");

	const [queue, setQueue] = useAtom(pendingApprovalQueueAtom);
	const sessionQueue = useMemo(() => approvalRequestsForSession(queue, ref), [queue, ref]);
	const pending = sessionQueue[0] ?? null;

	const respond = useCallback(
		async (approved: boolean) => {
			if (!pending) return;
			await hostSessionApi.respondToApproval(pending.requestId, approved);
			setQueue((current) => removeDialogRequest(current, pending.requestId));
		},
		[hostSessionApi, pending, setQueue],
	);

	return { pending, pendingCount: sessionQueue.length, respond };
}
