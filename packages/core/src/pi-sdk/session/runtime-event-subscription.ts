import type { SessionQueue } from "@ling/contracts/session";
import { throwAggregateFailures } from "@ling/core/ling-error";
import type { SessionRuntimeChangeReviewEvent, SessionRuntimeEvent } from "@ling/core/pi-protocol/runtime-types";
import type { PiAgentSession } from "../types";
import type { PiQueueMirror } from "./queue-mirror";
import { createPiSessionEventAdapter } from "./session-event-adapter";

interface RuntimeEventSubscriptionOptions {
	session: PiAgentSession;
	subscribeChangeReview(listener: (event: SessionRuntimeChangeReviewEvent) => void): () => void;
	subscribeQueue(listener: (queue: SessionQueue) => void): () => void;
	queueMirror(): PiQueueMirror;
	getMarkdownWidth(): number;
}

export function subscribePiRuntimeEvents(
	options: RuntimeEventSubscriptionOptions,
	listener: (event: SessionRuntimeEvent) => void,
): () => void {
	let active = true;
	const unsubscribeChangeReview = options.subscribeChangeReview(listener);
	const unsubscribeQueue = options.subscribeQueue((queue) => listener({ type: "queueChanged", queue }));
	const adapter = createPiSessionEventAdapter({
		session: options.session,
		getMarkdownWidth: options.getMarkdownWidth,
		queueMirror: options.queueMirror,
		onDeferredEvent: (event) => {
			if (active) listener(event);
		},
	});
	const unsubscribeSession = options.session.subscribe((event) => {
		const normalized = adapter.adapt(event);
		if (!normalized) return;
		listener(normalized);
	});
	return () => {
		active = false;
		const failures: unknown[] = [];
		for (const cleanup of [unsubscribeChangeReview, unsubscribeQueue, () => adapter.dispose(), unsubscribeSession]) {
			try {
				cleanup();
			} catch (error) {
				failures.push(error);
			}
		}
		throwAggregateFailures(failures, "Failed to dispose the Pi runtime event subscription");
	};
}
