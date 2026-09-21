import type { SessionEventEnvelope, SessionSnapshot } from "@ling/contracts/session";
import { applyToolExecutionProgress } from "@ling/contracts/session-tool-progress";
import { emptySessionTranscriptState, emptySessionView, type SessionView } from "../state/session";
import {
	applySessionEvent,
	deriveAutoRetryStatus,
	deriveBusyState,
	deriveErrorProjection,
	deriveSummarizationRetryStatus,
} from "./session-events";
import { advanceTranscriptRevision, applyTranscriptTail } from "./session-transcript-projection";

type SessionViewInput =
	| { type: "event"; envelope: SessionEventEnvelope }
	| { type: "snapshot"; snapshot: SessionSnapshot }
	| { type: "clear" }
	| { type: "clearTranscript" }
	| { type: "rollover" }
	| { type: "hibernate"; preserveTranscript: boolean }
	| { type: "wake" }
	| { type: "evict" };

function dormantTranscript(view: SessionView) {
	return {
		...view.transcript,
		runtimeId: null,
		generation: 0,
		currentRevision: 0,
		chainRevision: 0,
		olderCursor: null,
	};
}

/** Applies an already fenced input atomically; transport ordering and side effects stay with their owners. */
export function reduceSessionView(view: SessionView, input: SessionViewInput): SessionView {
	switch (input.type) {
		case "event": {
			const { envelope } = input;
			const { event } = envelope;
			const error = deriveErrorProjection(event);
			const busy = deriveBusyState(event);
			const retry = deriveSummarizationRetryStatus(event);
			const autoRetry = deriveAutoRetryStatus(event);
			return {
				...view,
				messages: applySessionEvent(view.messages, event),
				transcript: advanceTranscriptRevision(view.transcript, envelope),
				toolExecutions: applyToolExecutionProgress(view.toolExecutions, event),
				...(busy === undefined ? {} : { busy }),
				...(error === undefined ? {} : { error: error.hasError, errorMessage: error.message }),
				...(retry === undefined ? {} : { summarizationRetry: retry }),
				...(autoRetry === undefined ? {} : { autoRetry }),
				...(event.type === "queueChanged" ? { queue: event.queue } : {}),
			};
		}
		case "snapshot": {
			const { snapshot } = input;
			const projection = applyTranscriptTail(view.messages, view.transcript, snapshot.transcriptTail);
			return {
				...view,
				messages: projection.messages,
				transcript: { ...projection.state, transcriptCacheKey: snapshot.transcriptCacheKey },
				busy: snapshot.busy,
				toolExecutions: snapshot.toolExecutions,
				summarizationRetry: snapshot.summarizationRetry,
				autoRetry: snapshot.autoRetry,
				queue: snapshot.queue,
				error: snapshot.diagnostics.some((item) => item.severity === "error"),
			};
		}
		case "clear":
			// Resync is not a failed turn. Keep its existing error until an authoritative event replaces it.
			return { ...emptySessionView(view.transcript.epoch + 1), error: view.error, errorMessage: view.errorMessage };
		case "clearTranscript":
			return { ...view, messages: [], transcript: emptySessionTranscriptState(view.transcript.epoch + 1) };
		case "rollover":
			return {
				...view,
				toolExecutions: [],
				transcript: {
					...emptySessionTranscriptState(view.transcript.epoch + 1),
					hydrationSettled: view.transcript.hydrationSettled,
					hasOlder: view.transcript.hasOlder,
				},
			};
		case "hibernate":
			return input.preserveTranscript
				? { ...emptySessionView(), messages: view.messages, transcript: dormantTranscript(view) }
				: emptySessionView(view.transcript.epoch + 1);
		case "wake":
			return { ...view, toolExecutions: [], transcript: dormantTranscript(view), error: false, errorMessage: null };
		case "evict":
			return emptySessionView(view.transcript.epoch + 1);
	}
}
