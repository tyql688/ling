import type { SessionEventEnvelope } from "@ling/contracts/session";

export type ScheduleSessionMessageUpdateFlush = (callback: () => void) => () => void;

interface SessionMessageUpdateBatcher {
	enqueue(key: string, envelope: SessionEventEnvelope): void;
	flush(key: string): void;
	discard(key: string): void;
	dispose(): void;
}

interface SessionMessageUpdateBatcherOptions {
	schedule: ScheduleSessionMessageUpdateFlush;
	onFlush: (key: string, envelopes: readonly SessionEventEnvelope[]) => void;
}

/** A renderer frame should be tiny, but hidden/throttled windows can delay it. */
const MESSAGE_UPDATE_BATCH_CAPACITY_PER_SESSION = 256;
const MESSAGE_UPDATE_BATCH_CAPACITY_GLOBAL = 1_024;

/** Coalesces full updates while preserving every dependent delta. Stream validation remains synchronous at the caller,
 * while any ordering boundary can flush one session before projecting the next event. */
export function createSessionMessageUpdateBatcher(
	options: SessionMessageUpdateBatcherOptions,
): SessionMessageUpdateBatcher {
	const pending = new Map<string, SessionEventEnvelope[]>();
	let pendingEnvelopeCount = 0;
	let cancelScheduledFlush: (() => void) | null = null;
	let disposed = false;

	const cancelIfIdle = (): void => {
		if (pending.size !== 0 || !cancelScheduledFlush) return;
		cancelScheduledFlush();
		cancelScheduledFlush = null;
	};

	const flushKey = (key: string): void => {
		const envelopes = pending.get(key);
		if (!envelopes) return;
		pending.delete(key);
		pendingEnvelopeCount -= envelopes.length;
		options.onFlush(key, envelopes);
	};

	const flushAll = (): void => {
		cancelScheduledFlush = null;
		const queued = [...pending.entries()];
		pending.clear();
		pendingEnvelopeCount = 0;
		for (const [key, envelopes] of queued) options.onFlush(key, envelopes);
	};

	const ensureScheduled = (): void => {
		if (cancelScheduledFlush) return;
		cancelScheduledFlush = options.schedule(flushAll);
	};

	return {
		enqueue(key, envelope) {
			if (disposed) throw new Error("Session message update batcher is disposed");
			if (envelope.event.type !== "messageUpdate" && envelope.event.type !== "messageDelta") {
				throw new Error(`Cannot batch session event: ${envelope.event.type}`);
			}
			const messageId = envelope.event.type === "messageDelta" ? envelope.event.messageId : envelope.event.message.id;
			let queued = pending.get(key);
			if ((queued?.length ?? 0) >= MESSAGE_UPDATE_BATCH_CAPACITY_PER_SESSION) {
				flushKey(key);
				queued = undefined;
			}
			if (pendingEnvelopeCount >= MESSAGE_UPDATE_BATCH_CAPACITY_GLOBAL) {
				cancelScheduledFlush?.();
				cancelScheduledFlush = null;
				flushAll();
				queued = undefined;
			}
			if (!queued) {
				pending.set(key, [envelope]);
				pendingEnvelopeCount += 1;
			} else if (envelope.event.type === "messageDelta") {
				queued.push(envelope);
				pendingEnvelopeCount += 1;
			} else {
				// A full frame supersedes earlier full/delta projections for the same message only.
				const matches = (item: SessionEventEnvelope) =>
					item.event.type === "messageDelta"
						? item.event.messageId === messageId
						: item.event.type === "messageUpdate" && item.event.message.id === messageId;
				const existingIndex = queued.findIndex(matches);
				if (existingIndex < 0) {
					queued.push(envelope);
					pendingEnvelopeCount += 1;
				} else {
					const retained = queued.filter((item, index) => index === existingIndex || !matches(item));
					retained[existingIndex] = envelope;
					pendingEnvelopeCount -= queued.length - retained.length;
					pending.set(key, retained);
				}
			}
			ensureScheduled();
		},
		flush(key) {
			flushKey(key);
			cancelIfIdle();
		},
		discard(key) {
			const discarded = pending.get(key);
			if (discarded) pendingEnvelopeCount -= discarded.length;
			pending.delete(key);
			cancelIfIdle();
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			pending.clear();
			pendingEnvelopeCount = 0;
			cancelScheduledFlush?.();
			cancelScheduledFlush = null;
		},
	};
}
