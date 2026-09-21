import type { LingSessionEvent, SessionQueue } from "@ling/contracts/session";

export interface SessionQueueController {
	/** Observe runtime queue snapshots and stamp them with the next owned revision. */
	observe(event: LingSessionEvent): LingSessionEvent;
	/** Serialize a mutation behind every previously submitted queue mutation. */
	run<T>(operation: () => Promise<T>): Promise<T>;
	/** Reject a mutation rendered from an obsolete queue snapshot. */
	assertRevision(expectedRevision: number): void;
	/** Stamp a point-in-time runtime queue for a session snapshot. */
	project(queue: SessionQueue): SessionQueue;
	/** Wait until every submitted mutation has settled during runtime disposal. */
	drain(): Promise<void>;
}

export function createSessionQueueController(): SessionQueueController {
	let revision = 0;
	let operationTail = Promise.resolve();

	return {
		observe(event) {
			if (event.type !== "queueChanged") return event;
			revision += 1;
			return { ...event, queue: { ...event.queue, revision } };
		},
		run<T>(operation: () => Promise<T>) {
			const result = operationTail.then(operation);
			operationTail = result.then(
				() => undefined,
				() => undefined,
			);
			return result;
		},
		assertRevision(expectedRevision) {
			if (revision === expectedRevision) return;
			throw Object.assign(
				new Error(
					`Session queue changed while the operation was pending (expected ${expectedRevision}, received ${revision})`,
				),
				{ code: "SESSION_QUEUE_CHANGED" as const, expectedRevision, actualRevision: revision },
			);
		},
		project(queue) {
			return { ...queue, revision };
		},
		drain() {
			return operationTail;
		},
	};
}
