import type { SessionRef, SessionTitleChangedEvent } from "@ling/contracts/session";
import { sessionProcedures } from "@ling/contracts/session-procedures";
import { sessionKey } from "@ling/contracts/session-ref";
import type { ExtensionUiBridge } from "@ling/core/pi-protocol/extension-ui";
import type { ManagedSessionManager } from "@ling/host/domains/sessions/manager/session-manager";
import type { ChangeReviewOperationRegistry } from "@ling/host/domains/review/operations";
import type { HostEventPublisher } from "@ling/host/transport/event-bus";
import type { HostShellActivity } from "@ling/host/transport/shell-activity";
import type { SessionEventBridgeHost } from "./session-event-bridge";

interface RegisterSessionLifecycleHostOptions {
	manager: ManagedSessionManager;
	extensionUi: ExtensionUiBridge;
	reviewOperations: ChangeReviewOperationRegistry;
	events: HostEventPublisher;
	shellActivity: HostShellActivity;
	eventBridge: SessionEventBridgeHost;
	cancelSessionOperations(ref: SessionRef, reason: "sessionLifecycleFailed" | "sessionReplaced"): void;
	/** Detach event bridges and dialogs synchronously (must run before bind(next) on replace). */
	releaseSessionEventBridges(refs: readonly SessionRef[]): void;
	/** Async change-review / heavy cleanup after bridges are already detached. */
	releaseSessionReviewInBackground(refs: readonly SessionRef[]): void;
	onSessionRuntimesFailed(refs: readonly SessionRef[]): void;
	onSessionRuntimeReplaced(previousRef: SessionRef, nextRef: SessionRef): void;
}

/** Owns Host-lifetime session signals that coordinate more than one per-session bridge. */
export function registerSessionLifecycleHost(options: RegisterSessionLifecycleHostOptions): () => void {
	const { onExtensionUiStateChanged } = options.extensionUi;
	const { onSessionLifecycleFailed, onSessionReplaced, onSessionTitleChanged } = options.manager.lifecycleEvents;
	const { tryCreateExtensionUiChangedEnvelope } = options.manager.registry;

	const changeReviewDiffOperations = options.reviewOperations;
	const unsubscribeTitle = onSessionTitleChanged((ref, title) => {
		const payload: SessionTitleChangedEvent = { ref, title };
		options.events.broadcast(sessionProcedures.onTitleChanged.channel, payload);
	});

	const unsubscribeLifecycleFailure = onSessionLifecycleFailed((_ref, _error, relatedRefs, envelope) => {
		for (const relatedRef of relatedRefs) {
			options.cancelSessionOperations(relatedRef, "sessionLifecycleFailed");
			changeReviewDiffOperations.cancelByRef(relatedRef, "sessionLifecycleFailed");
		}
		// Bridges first (sync), then heavy review disposal in the background.
		options.releaseSessionEventBridges(relatedRefs);
		options.releaseSessionReviewInBackground(relatedRefs);
		options.events.broadcast(sessionProcedures.onEvent.channel, envelope);
		// The ordered failure envelope remains observable before renderer eviction.
		options.onSessionRuntimesFailed(relatedRefs);
	});

	const unsubscribeExtensionUi = onExtensionUiStateChanged((ref, _state, event) => {
		const payload = tryCreateExtensionUiChangedEnvelope(ref);
		if (!payload) return;
		// Extension info notes (e.g. "<extension> loaded") stay in the in-app notification
		// history; only warnings and errors interrupt the user with a system toast.
		if (event.type === "notify" && event.level !== "info") {
			options.shellActivity.notify(ref, "attentionNeeded", "Ling", event.message);
		}
		options.events.broadcast(sessionProcedures.onEvent.channel, payload);
	});

	const unsubscribeReplacement = onSessionReplaced((event, envelope) => {
		// A same-file refresh keeps previousRef === nextRef: the session is still live, so
		// cancelling its operations or releasing its subscriptions would sabotage it.
		const sameSession = sessionKey(event.previousRef) === sessionKey(event.nextRef);
		options.onSessionRuntimeReplaced(event.previousRef, event.nextRef);
		if (!sameSession) {
			options.cancelSessionOperations(event.previousRef, "sessionReplaced");
			changeReviewDiffOperations.cancelByRef(event.previousRef, "sessionReplaced");
			// Detach the previous bridge before binding next — fire-and-forget release let
			// both listeners stack on the same managed object and double-forward events.
			options.releaseSessionEventBridges([event.previousRef]);
			options.releaseSessionReviewInBackground([event.previousRef]);
		}
		options.eventBridge.bind(event.nextRef);
		options.events.broadcast(sessionProcedures.onEvent.channel, envelope);
	});

	let disposed = false;
	return () => {
		if (disposed) return;
		disposed = true;
		unsubscribeReplacement();
		unsubscribeExtensionUi();
		unsubscribeLifecycleFailure();
		unsubscribeTitle();
	};
}
