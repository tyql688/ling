interface DialogRequestIdentity {
	requestId: string;
}

function appendUniqueRequest<TRequest extends DialogRequestIdentity>(queue: TRequest[], request: TRequest): TRequest[] {
	return queue.some((entry) => entry.requestId === request.requestId) ? queue : [...queue, request];
}

export function removeDialogRequest<TRequest extends DialogRequestIdentity>(
	queue: TRequest[],
	requestId: string,
): TRequest[] {
	if (!queue.some((request) => request.requestId === requestId)) return queue;
	return queue.filter((request) => request.requestId !== requestId);
}

interface DialogRequestReplay<TRequest extends DialogRequestIdentity> {
	receive(queue: TRequest[], request: TRequest): TRequest[];
	dismiss(queue: TRequest[], requestId: string): TRequest[];
	reconcile(pending: readonly TRequest[]): TRequest[];
}

/**
 * Reconciles a main-process pending snapshot with live IPC events received while
 * that snapshot is in flight. A dismissal becomes a short-lived tombstone so a
 * stale snapshot cannot resurrect an already-settled request.
 */
export function createDialogRequestReplay<TRequest extends DialogRequestIdentity>(): DialogRequestReplay<TRequest> {
	const liveRequests = new Map<string, TRequest>();
	const dismissedRequestIds = new Set<string>();
	let replaying = true;

	return {
		receive(queue, request) {
			if (dismissedRequestIds.has(request.requestId)) return queue;
			if (replaying) liveRequests.set(request.requestId, request);
			return appendUniqueRequest(queue, request);
		},
		dismiss(queue, requestId) {
			if (replaying) dismissedRequestIds.add(requestId);
			liveRequests.delete(requestId);
			return removeDialogRequest(queue, requestId);
		},
		reconcile(pending) {
			const merged: TRequest[] = [];
			const seen = new Set<string>();
			for (const request of [...pending, ...liveRequests.values()]) {
				if (dismissedRequestIds.has(request.requestId) || seen.has(request.requestId)) continue;
				seen.add(request.requestId);
				merged.push(request);
			}
			replaying = false;
			liveRequests.clear();
			dismissedRequestIds.clear();
			return merged;
		},
	};
}
