import type {
	LingSessionEvent,
	SessionEventEnvelope,
	SessionRef,
	SessionRuntimeWatermark,
} from "@ling/contracts/session";
import { sessionEventPolicy } from "@ling/contracts/session-event-policy";
import { randomUUID } from "node:crypto";

/** Event envelope protocol version; renderer and main must agree. */
const PROTOCOL_VERSION = 1 as const;

function timestamp(value: number, label: string): number {
	if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer`);
	return value;
}

function eventOccurredAt(event: LingSessionEvent, now: number): number {
	if (event.type === "runStarted" || event.type === "runFinished") {
		return timestamp(event.timestamp, `${event.type}.timestamp`);
	}
	if (event.type === "compactionSummary") {
		return timestamp(event.message.timestamp, "compactionSummary.message.timestamp");
	}
	return now;
}

export interface SessionEventStream {
	watermark(): SessionRuntimeWatermark;
	publish(ref: SessionRef, event: LingSessionEvent): SessionEventEnvelope;
	rollover(): SessionRuntimeWatermark;
}

export function createSessionEventStream(): SessionEventStream {
	const runtimeId = randomUUID();
	let generation = 1;
	let lastSequence = 0;
	let stateRevision = 0;
	let transcriptRevision = 0;

	function watermark(): SessionRuntimeWatermark {
		return {
			protocolVersion: PROTOCOL_VERSION,
			runtimeId,
			generation,
			lastSequence,
			stateRevision,
			transcriptRevision,
		};
	}

	return {
		watermark,
		publish(ref, event) {
			const currentTime = timestamp(Date.now(), "Session event stream clock");
			const occurredAt = eventOccurredAt(event, currentTime);
			const policy = sessionEventPolicy(event);
			lastSequence += 1;
			if (policy.stateEffect) stateRevision += 1;
			if (policy.transcriptEffect) transcriptRevision += 1;
			return {
				protocolVersion: PROTOCOL_VERSION,
				runtimeId,
				generation,
				sequence: lastSequence,
				stateRevision,
				transcriptRevision,
				ref,
				occurredAt,
				deliveryClass: policy.deliveryClass,
				event,
			};
		},
		rollover() {
			generation += 1;
			lastSequence = 0;
			stateRevision = 0;
			transcriptRevision = 0;
			return watermark();
		},
	};
}
