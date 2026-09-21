import { notifyListeners } from "@ling/core/listeners";
import type { SessionEventEnvelope, SessionRef } from "@ling/contracts/session";
import type {
	SessionRuntimeChangeReviewEvent,
	SessionRuntimeReplacementEvent,
} from "@ling/core/pi-protocol/runtime-types";

export type SessionEventListener = (envelope: SessionEventEnvelope) => void;
export type SessionChangeReviewEventListener = (ref: SessionRef, event: SessionRuntimeChangeReviewEvent) => void;
type TitleChangeListener = (ref: SessionRef, title: string) => void;
type SessionReplacementListener = (event: SessionRuntimeReplacementEvent, envelope: SessionEventEnvelope) => void;
type SessionLifecycleFailureListener = (
	ref: SessionRef,
	error: unknown,
	relatedRefs: readonly SessionRef[],
	envelope: SessionEventEnvelope,
) => void;

export function createSessionLifecycleEvents() {
	const titleChangeListeners = new Set<TitleChangeListener>();
	const sessionReplacementListeners = new Set<SessionReplacementListener>();
	const sessionLifecycleFailureListeners = new Set<SessionLifecycleFailureListener>();

	function onSessionTitleChanged(listener: TitleChangeListener): () => void {
		titleChangeListeners.add(listener);
		return () => titleChangeListeners.delete(listener);
	}

	function onSessionReplaced(listener: SessionReplacementListener): () => void {
		sessionReplacementListeners.add(listener);
		return () => sessionReplacementListeners.delete(listener);
	}

	function onSessionLifecycleFailed(listener: SessionLifecycleFailureListener): () => void {
		sessionLifecycleFailureListeners.add(listener);
		return () => sessionLifecycleFailureListeners.delete(listener);
	}

	function publishSessionTitleChanged(ref: SessionRef, title: string): void {
		notifyListeners(titleChangeListeners, "session title", ref, title);
	}

	function publishSessionReplaced(event: SessionRuntimeReplacementEvent, envelope: SessionEventEnvelope): void {
		notifyListeners(sessionReplacementListeners, "session replacement", event, envelope);
	}

	function publishSessionLifecycleFailed(
		ref: SessionRef,
		error: unknown,
		relatedRefs: readonly SessionRef[],
		envelope: SessionEventEnvelope,
	): void {
		notifyListeners(sessionLifecycleFailureListeners, "session lifecycle failure", ref, error, relatedRefs, envelope);
	}

	function dispose(): void {
		titleChangeListeners.clear();
		sessionReplacementListeners.clear();
		sessionLifecycleFailureListeners.clear();
	}
	return {
		onSessionTitleChanged,
		onSessionReplaced,
		onSessionLifecycleFailed,
		publishSessionTitleChanged,
		publishSessionReplaced,
		publishSessionLifecycleFailed,
		dispose,
	};
}

export type SessionLifecycleEvents = ReturnType<typeof createSessionLifecycleEvents>;
