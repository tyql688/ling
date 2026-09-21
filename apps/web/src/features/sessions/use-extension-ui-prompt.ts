import { useDomainApi } from "@renderer/lib/host-api-context";
import type { ExtensionUiRequest } from "@ling/contracts/session";
import type { SessionRef } from "@ling/contracts/session-ref";
import { sameSessionRef } from "@ling/contracts/session-ref";
import { pendingExtensionUiQueueAtom } from "@renderer/features/sessions/state/session";
import { usePairedDialogQueue } from "@renderer/hooks/use-paired-dialog-queue";
import { useCallback, useMemo } from "react";

function extensionUiRequestsForSession(
	queue: readonly ExtensionUiRequest[],
	ref: SessionRef | null,
): ExtensionUiRequest[] {
	return ref === null ? [] : queue.filter((request) => sameSessionRef(request.ref, ref));
}

export function useExtensionUiPrompt(ref: SessionRef | null) {
	const hostSessionApi = useDomainApi("session");

	const { queue, remove } = usePairedDialogQueue(pendingExtensionUiQueueAtom, {
		getPending: hostSessionApi.pendingExtensionUiRequests,
		onRequest: hostSessionApi.onExtensionUiRequest,
		onDismiss: hostSessionApi.onExtensionUiDismiss,
	});
	const sessionQueue = useMemo(() => extensionUiRequestsForSession(queue, ref), [queue, ref]);
	const pending = sessionQueue[0] ?? null;

	const respond = useCallback(
		async (value: string | null) => {
			if (pending === null) return;
			await hostSessionApi.respondToExtensionUi(pending.requestId, value);
			remove(pending.requestId);
		},
		[hostSessionApi, pending, remove],
	);

	return { pending, pendingCount: sessionQueue.length, respond };
}
