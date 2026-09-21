import type { ExtensionUiBridge } from "@ling/core/pi-protocol/extension-ui";
import { notifyListeners } from "@ling/core/listeners";
import type { SessionLifecycleEvents } from "./session-lifecycle-events";
import { applyToolExecutionProgress } from "@ling/contracts/session-tool-progress";
import type { SessionEventEnvelope, SessionRef } from "@ling/contracts/session";
import { errorMessage } from "@ling/contracts/ling-error";
import { sessionKey } from "@ling/contracts/session-ref";
import { disableSessionAutoTitle, startSessionAutoTitle } from "./session-auto-title";
import type { ManagedSession } from "./session-managed-state";
import type { SessionReplacementReservations } from "./session-replacement-reservations";
import type { SessionRuntimeEvent, SessionRuntimeReplacementEvent } from "@ling/core/pi-protocol/runtime-types";

interface ManagedSessionRuntimeEventOptions {
	extensionUi: ExtensionUiBridge;
	lifecycleEvents: SessionLifecycleEvents;
	replacements: SessionReplacementReservations<ManagedSession>;
	isCurrent(managed: ManagedSession): boolean;
	clearRef(ref: SessionRef, managed: ManagedSession): void;
	rememberReplacement(previousRef: SessionRef, nextRef: SessionRef): void;
	trackProjectOperation(cwd: string, operation: Promise<void>): Promise<void>;
	publishSummary(managed: ManagedSession): void;
}

function replacementPlaceholderTitle(reason: SessionRuntimeReplacementEvent["reason"]): string {
	if (reason === "fork") return "Forked session";
	return "New session";
}

function subscribeAgent(managed: ManagedSession, options: ManagedSessionRuntimeEventOptions): () => void {
	return managed.session.subscribe((event: SessionRuntimeEvent) => {
		if (event.type === "changeReviewFileUpdated" || event.type === "changeReviewTrackingFailed") {
			notifyListeners(managed.changeReviewListeners, "change review event", managed.ref, event);
			return;
		}
		const normalized = managed.queue.observe(event);
		managed.toolExecutions = applyToolExecutionProgress(managed.toolExecutions, normalized);
		if (normalized.type === "summarizationRetryChanged") {
			managed.summarizationRetry = normalized.status;
		} else if (normalized.type === "autoRetryChanged") {
			managed.autoRetry = normalized.status;
		} else if (normalized.type === "messageStart" && normalized.message.role === "assistant") {
			managed.autoRetry = null;
		} else if (normalized.type === "runFinished") {
			managed.summarizationRetry = null;
			managed.autoRetry = null;
		}
		if (normalized.type === "snapshotChanged" || normalized.type === "transcriptInvalidated") {
			managed.transcriptPager.invalidate();
		}
		const envelope = managed.eventStream.publish(managed.ref, normalized);
		notifyListeners(managed.listeners, "session event", envelope);
		if (normalized.type === "snapshotChanged") options.publishSummary(managed);
		if (normalized.type === "runFinished" && normalized.runId === "compaction") {
			// Compaction rewrote the transcript; refresh the sidebar summary without the
			// agent-turn side effects (auto-title, notifications) a real turn would trigger.
			options.publishSummary(managed);
		}
		if (normalized.type === "runFinished" && normalized.runId === "agent") {
			// Ordinary Pi messages do not emit entry_appended. Agent settlement is the
			// durable turn boundary, so publish one final summary without rescanning the
			// complete session after every persisted tool or conversation message.
			options.publishSummary(managed);
			startSessionAutoTitle(managed, {
				isCurrent: options.isCurrent,
				track: options.trackProjectOperation,
				publishSummary: options.publishSummary,
				publishTitle: options.lifecycleEvents.publishSessionTitleChanged,
			});
		}
		// Keep the file-sync baseline aligned with Pi's own JSONL appends. Without this,
		// mid-turn/post-turn send checks treat Ling's writes as external divergence and
		// surface SESSION_FILE_DIVERGED for every steer/followUp after the first append.
		if (
			normalized.type === "runFinished" ||
			normalized.type === "snapshotChanged" ||
			normalized.type === "messagePersisted"
		) {
			void managed.fileSync.acceptCurrentState();
		}
		// Pi can publish runFinished before its final idle flag, while compaction and
		// extension-owned activity may settle without runFinished. The reload revision
		// guard makes ordinary events a no-op.
		managed.resourceReload.triggerAfterCurrent();
	});
}

export function publishManagedExtensionUiChanged(managed: ManagedSession): SessionEventEnvelope {
	managed.extensionUiRevision += 1;
	return managed.eventStream.publish(managed.ref, {
		type: "extensionUiChanged",
		revision: managed.extensionUiRevision,
	});
}

export function resumeManagedExtensionUiEvents(
	managed: ManagedSession,
	isCurrent: (managed: ManagedSession) => boolean,
): void {
	if (!managed.extensionUiEventsSuspended) return;
	managed.extensionUiEventsSuspended = false;
	if (!managed.extensionUiChangePending) return;
	managed.extensionUiChangePending = false;
	if (!isCurrent(managed)) return;
	const envelope = publishManagedExtensionUiChanged(managed);
	notifyListeners(managed.listeners, "session event", envelope);
}

/** Installs every runtime-owned subscription. Callers retain registry/disposal ownership. */
export function bindManagedSessionRuntimeEvents(
	managed: ManagedSession,
	options: ManagedSessionRuntimeEventOptions,
): void {
	const { session } = managed;
	managed.unsubscribeAgent = subscribeAgent(managed, options);
	managed.unsubscribeReplacementCoordinator = session.setReplacementCoordinator((event) =>
		options.replacements.prepare(managed, event),
	);
	managed.unsubscribeReplacement = session.onSessionReplaced((event) => {
		options.replacements.assertCommitted(managed, event);
		managed.autoTitleInFlight = false;
		if (sessionKey(event.previousRef) !== sessionKey(event.nextRef)) {
			options.clearRef(event.previousRef, managed);
			options.rememberReplacement(event.previousRef, event.nextRef);
		}

		managed.ref = event.nextRef;
		managed.cwd = event.nextRef.cwd;

		// Dispose is waiting for this replace so ownership can commit. Never re-arm
		// projections, bridges, file watches, or auto-title for a session that is leaving.
		if (managed.disposing) return;

		managed.eventStream.rollover();
		managed.toolExecutions = [];
		managed.transcriptPager.invalidate();
		managed.commandCatalogRevision = 0;
		managed.extensionUiRevision = 0;
		managed.extensionUiEventsSuspended = false;
		managed.extensionUiChangePending = false;
		managed.summarizationRetry = null;
		managed.autoRetry = null;
		managed.commandCatalog = managed.session.listCommands();
		if (event.reason !== "refresh") {
			// A refresh re-opens the same session; its identity and titling are untouched.
			managed.createdAt = Date.now();
			managed.placeholderTitle = replacementPlaceholderTitle(event.reason);
			managed.autoTitleEnabled = !(event.reason === "switch" && managed.session.getSessionName());
		}
		void managed.fileSync.acceptCurrentState();
		if (managed.extensionUiRequester)
			options.extensionUi.registerExtensionUiRequester(event.nextRef, managed.extensionUiRequester);
		if (managed.approvalRequester)
			options.extensionUi.registerApprovalRequester(event.nextRef, managed.approvalRequester);
		managed.unsubscribeAgent();
		managed.unsubscribeAgent = subscribeAgent(managed, options);
		const envelope = managed.eventStream.publish(event.nextRef, {
			type: "sessionReplaced",
			previousRef: event.previousRef,
			reason: event.reason,
		});
		options.lifecycleEvents.publishSessionReplaced(event, envelope);
		options.publishSummary(managed);
		const catalogEnvelope = managed.eventStream.publish(event.nextRef, {
			type: "sessionCatalogChanged",
			reason: "replacement",
		});
		notifyListeners(managed.listeners, "session event", catalogEnvelope);
		if (
			event.reason === "switch" &&
			!managed.session.getSessionName() &&
			managed.session.summarize(managed.createdAt, managed.placeholderTitle).messageCount > 0
		) {
			startSessionAutoTitle(managed, {
				isCurrent: options.isCurrent,
				track: options.trackProjectOperation,
				publishSummary: options.publishSummary,
				publishTitle: options.lifecycleEvents.publishSessionTitleChanged,
			});
		}
		managed.resourceReload.triggerAfterCurrent();
	});
	managed.unsubscribeSnapshotChanged = session.onSnapshotChanged((snapshotRef) => {
		managed.transcriptPager.invalidate();
		// Tree navigation and other runtime-side snapshot writes are Ling-owned.
		void managed.fileSync.acceptCurrentState();
		const envelope = managed.eventStream.publish(snapshotRef, { type: "snapshotChanged" });
		notifyListeners(managed.listeners, "session event", envelope);
		options.publishSummary(managed);
		managed.resourceReload.triggerAfterCurrent();
	});
	managed.unsubscribeTranscriptInvalidated = session.onTranscriptInvalidated((transcriptRef, reason) => {
		// Both reasons are runtime-side writes to the session file (tree navigation
		// appends, reload re-reads), so accept them as Ling's own state.
		void managed.fileSync.acceptCurrentState();
		managed.transcriptPager.invalidate();
		if (reason === "reload") {
			// Resource reload commits a clean AgentSession generation under the same
			// Ling identity. Retire companion requests from the old generation and
			// move the normalized event adapter to the clean runtime.
			managed.eventStream.rollover();
			managed.toolExecutions = [];
			managed.unsubscribeAgent();
			managed.unsubscribeAgent = subscribeAgent(managed, options);
			managed.summarizationRetry = null;
			managed.autoRetry = null;
		}
		const envelope = managed.eventStream.publish(transcriptRef, { type: "transcriptInvalidated", reason });
		notifyListeners(managed.listeners, "session event", envelope);
		if (reason === "reload") {
			managed.commandCatalog = managed.session.listCommands();
			managed.commandCatalogRevision += 1;
			const commandsEnvelope = managed.eventStream.publish(transcriptRef, {
				type: "commandsChanged",
				revision: managed.commandCatalogRevision,
			});
			notifyListeners(managed.listeners, "session event", commandsEnvelope);
			managed.extensionUiRevision += 1;
			const extensionUiEnvelope = managed.eventStream.publish(transcriptRef, {
				type: "extensionUiChanged",
				revision: managed.extensionUiRevision,
			});
			notifyListeners(managed.listeners, "session event", extensionUiEnvelope);
			// The new-generation snapshot represents state emitted while binding.
			managed.extensionUiChangePending = false;
			managed.extensionUiEventsSuspended = false;
		}
	});
	managed.unsubscribeTranscriptProjectionChanged = session.onTranscriptProjectionChanged((transcriptRef, reason) => {
		// Display-only projections change transcript payloads without touching JSONL,
		// summaries, file-sync baselines, resource generations, or active operations.
		managed.transcriptPager.invalidate();
		const envelope = managed.eventStream.publish(transcriptRef, { type: "transcriptProjectionChanged", reason });
		notifyListeners(managed.listeners, "session event", envelope);
	});
	managed.unsubscribeLifecycleFailure = session.onLifecycleFailed((failedRef, error, relatedRefs) => {
		const envelope = managed.eventStream.publish(failedRef, {
			type: "runFinished",
			runId: "session-lifecycle",
			outcome: { status: "failed", message: errorMessage(error) },
			timestamp: Date.now(),
		});
		managed.lifecycleEpoch += 1;
		disableSessionAutoTitle(managed);
		managed.summarizationRetry = null;
		managed.autoRetry = null;
		managed.fileSync.stop();
		managed.unsubscribeAgent();
		managed.unsubscribeReplacementCoordinator();
		managed.unsubscribeReplacement();
		managed.unsubscribeSnapshotChanged();
		managed.unsubscribeTranscriptInvalidated();
		managed.unsubscribeTranscriptProjectionChanged();
		managed.unsubscribeLifecycleFailure();
		options.replacements.clear(managed);
		for (const refToClear of relatedRefs) options.clearRef(refToClear, managed);
		options.lifecycleEvents.publishSessionLifecycleFailed(failedRef, error, relatedRefs, envelope);
	});
}
