import { changeReviewProcedures } from "@ling/contracts/change-review-procedures";
import type { ChangeReviewTrackingEvent } from "@ling/contracts/git";
import type { SessionRef } from "@ling/contracts/session";
import { sessionProcedures } from "@ling/contracts/session-procedures";
import { sessionKey } from "@ling/contracts/session-ref";
import { createLogger } from "@ling/core/logger";
import type {
	SessionChangeReviewEventListener,
	SessionEventListener,
} from "@ling/host/domains/sessions/manager/session-lifecycle-events";
import type { SessionRegistry } from "@ling/host/domains/sessions/manager/session-registry";
import type { HostEventPublisher } from "@ling/host/transport/event-bus";
import type { HostShellActivity } from "@ling/host/transport/shell-activity";
import type { ChangeReviewHost } from "../review/change-review";
import type { SessionDialogHost } from "./session-dialog-host";

const log = createLogger("session-event-bridge");

export interface SessionEventBridgeHost {
	bind(ref: SessionRef): void;
	release(refs: readonly SessionRef[]): unknown[];
	dispose(): unknown[];
}

interface CreateSessionEventBridgeHostOptions {
	registry: SessionRegistry;
	review: Pick<
		ChangeReviewHost,
		"onChangeReviewLiveUpdate" | "recordChangeReviewFileUpdate" | "recordChangeReviewTrackingFailure"
	>;
	events: HostEventPublisher;
	shellActivity: HostShellActivity;
	dialogs: SessionDialogHost;
	cancelSessionOperations(ref: SessionRef): void;
	onSessionMayBeIdle(): void;
}

/** Extracts the final assistant text for a concise native/Web notification preview. */
function lastAssistantPreview(messages: readonly unknown[]): string {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (
			!message ||
			typeof message !== "object" ||
			!("role" in message) ||
			message.role !== "assistant" ||
			!("content" in message) ||
			!Array.isArray(message.content)
		) {
			continue;
		}
		const text = message.content
			.filter(
				(part): part is { type: string; text: string } =>
					part !== null && typeof part === "object" && part.type === "text" && typeof part.text === "string",
			)
			.map((part) => part.text)
			.join(" ");
		/** Notification previews use 117 content characters plus an ellipsis at the 120-character boundary. */
		return text.length > 120 ? `${text.slice(0, 117)}...` : text;
	}
	return "";
}

export function createSessionEventBridgeHost(options: CreateSessionEventBridgeHostOptions): SessionEventBridgeHost {
	const { onSessionChangeReviewEvent, onSessionEvent } = options.registry;

	const { onChangeReviewLiveUpdate, recordChangeReviewFileUpdate, recordChangeReviewTrackingFailure } = options.review;
	const subscriptions = new Map<string, { ref: SessionRef; unsubscribe: () => unknown[] }>();
	const host: SessionEventBridgeHost = {
		bind(ref) {
			const key = sessionKey(ref);
			// Re-selecting an already-bound session must not stack another event forwarder.
			if (subscriptions.has(key)) return;
			let completionPreview = "";
			let changeReviewRun = { failed: false };
			let agentRunStarted = false;
			let pendingBoundaryFailure = false;
			let subscribed = true;
			const publishChangeReviewTracking = (event: ChangeReviewTrackingEvent): void => {
				if (subscribed) options.events.broadcast(changeReviewProcedures.onTrackingEvent.channel, event);
			};
			const markFileTrackingFailed = (eventRef: SessionRef): void => {
				const run = changeReviewRun;
				void recordChangeReviewTrackingFailure(eventRef).then(
					(relevant) => {
						if (run !== changeReviewRun) return;
						if (!relevant) {
							if (agentRunStarted) run.failed = true;
							return;
						}
						publishChangeReviewTracking({ type: "updated", ref: eventRef });
					},
					(error: unknown) => {
						if (run !== changeReviewRun) return;
						run.failed = true;
						log.error("change review failure marker failed:", error);
						publishChangeReviewTracking({
							type: "failed",
							ref: eventRef,
							errorCode: "CHANGE_REVIEW_TRACKING_FAILED",
						});
					},
				);
			};
			const handleChangeReviewEvent: SessionChangeReviewEventListener = (eventRef, event) => {
				if (event.type === "changeReviewTrackingFailed") {
					log.error(`change review file tracking failed: ${event.code}`);
					if (!agentRunStarted) pendingBoundaryFailure = true;
					markFileTrackingFailed(eventRef);
					return;
				}
				const run = changeReviewRun;
				void recordChangeReviewFileUpdate(eventRef, event).then(
					(changed) => {
						if (run === changeReviewRun && changed && !run.failed) {
							publishChangeReviewTracking({ type: "updated", ref: eventRef });
						}
					},
					(error: unknown) => {
						log.error("change review file update failed:", error);
						markFileTrackingFailed(eventRef);
					},
				);
			};
			const handleSessionEvent: SessionEventListener = (envelope) => {
				const event = envelope.event;
				if (event.type === "snapshotChanged" || event.type === "transcriptInvalidated") {
					options.cancelSessionOperations(envelope.ref);
				}
				if (
					(event.type === "runStarted" && event.runId === "agent") ||
					(event.type === "runFinished" && event.runId === "agent")
				) {
					options.shellActivity.agentRunState(envelope.ref, event.type === "runStarted");
					if (event.type === "runStarted") {
						const run = { failed: pendingBoundaryFailure };
						pendingBoundaryFailure = false;
						changeReviewRun = run;
						agentRunStarted = true;
						// The awaited lifecycle hook has already established A. Clear the
						// previous turn before the new assistant stream reaches the renderer.
						publishChangeReviewTracking({ type: "started", ref: envelope.ref });
					} else {
						const run = changeReviewRun;
						agentRunStarted = false;
						publishChangeReviewTracking(
							run.failed
								? { type: "failed", ref: envelope.ref, errorCode: "CHANGE_REVIEW_TRACKING_FAILED" }
								: { type: "settled", ref: envelope.ref },
						);
						run.failed = false;
					}
				}
				options.events.broadcast(sessionProcedures.onEvent.channel, envelope);
				if (event.type === "runFinished" || event.type === "queueChanged" || event.type === "sessionSummaryChanged") {
					options.onSessionMayBeIdle();
				}
				if (event.type === "messageEnd" && event.message.role === "assistant") {
					completionPreview = lastAssistantPreview([event.message]);
				} else if (event.type === "runFinished" && event.runId === "agent") {
					if (event.outcome.status === "failed") {
						options.shellActivity.notify(
							envelope.ref,
							"backgroundCompletion",
							"Ling — run failed",
							event.outcome.message || "The agent run failed.",
						);
					} else if (event.outcome.status === "success") {
						options.shellActivity.notify(
							envelope.ref,
							"backgroundCompletion",
							"Ling — response ready",
							completionPreview || "The agent finished responding.",
						);
					}
					completionPreview = "";
				}
			};
			// Every acquisition below can reject: both registry subscriptions throw
			// SESSION_NOT_FOUND once the ref has left managedSessions, which a host loss racing
			// a replacement can do mid-bind. Unwind in reverse so a partial bind strands
			// neither a listener nor a dialog requester — nothing else would ever release them.
			const releases: Array<() => void> = [];
			const unwind = (): unknown[] => {
				subscribed = false;
				// A session released mid-run must not strand the display-sleep blocker.
				options.shellActivity.agentRunState(ref, false);
				const failures: unknown[] = [];
				for (const release of releases.splice(0).reverse()) {
					try {
						release();
					} catch (error) {
						failures.push(error);
					}
				}
				return failures;
			};
			try {
				releases.push(options.dialogs.bind(ref));
				releases.push(onChangeReviewLiveUpdate(ref, () => publishChangeReviewTracking({ type: "updated", ref })));
				releases.push(onSessionChangeReviewEvent(ref, handleChangeReviewEvent));
				releases.push(onSessionEvent(ref, handleSessionEvent));
			} catch (error) {
				for (const failure of unwind()) {
					log.error(`partial session bind unwind failed for ${ref.sessionId}:`, failure);
				}
				throw error;
			}
			subscriptions.set(key, { ref: { ...ref }, unsubscribe: unwind });
		},
		release(refs) {
			const failures: unknown[] = [];
			for (const ref of refs) {
				const key = sessionKey(ref);
				const subscription = subscriptions.get(key);
				subscriptions.delete(key);
				if (subscription) failures.push(...subscription.unsubscribe());
			}
			return failures;
		},
		dispose() {
			return host.release([...subscriptions.values()].map((subscription) => subscription.ref));
		},
	};
	return host;
}
