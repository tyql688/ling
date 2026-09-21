import type { ApprovalRequester, ExtensionUiRequester, ExtensionUiBridge } from "@ling/core/pi-protocol/extension-ui";
import { notifyListeners } from "@ling/core/listeners";
import type {
	SessionLifecycleEvents,
	SessionChangeReviewEventListener,
	SessionEventListener,
} from "./session-lifecycle-events";
import type { SessionLifecycleOperations } from "./session-lifecycle-operations";
import type { SessionRuntimeProvider } from "@ling/core/pi-protocol/runtime-provider";
import type { SessionEventEnvelope, SessionRef } from "@ling/contracts/session";
import { errorMessage } from "@ling/contracts/ling-error";
import { sessionKey } from "@ling/contracts/session-ref";
import { createLingError } from "@ling/core/ling-error";
import { createLogger } from "@ling/core/logger";
import { disableSessionAutoTitle, startSessionAutoTitle } from "./session-auto-title";
import { createSessionEventStream } from "./session-event-stream";
import { createSessionFileSyncController } from "./session-file-sync";
import { normalizeLingSessionTitle } from "./session-input";
import type { ManagedSession } from "./session-managed-state";
import { createSessionQueueController } from "./session-queue";
import { createReplacedRuntimeRefIndex } from "./session-ref-indexes";
import { createSessionReplacementReservations } from "./session-replacement-reservations";
import { createSessionResourceReloadController } from "./session-resource-reload";
import {
	bindManagedSessionRuntimeEvents,
	publishManagedExtensionUiChanged,
	resumeManagedExtensionUiEvents,
} from "./session-runtime-events";
import type { SessionRuntimePort } from "@ling/core/pi-protocol/runtime-port";
import { type ListedSessionSummary, projectManagedSessionSummary } from "./session-summary";
import { createTranscriptPager } from "../transcript-pager";

const log = createLogger("session-registry");

/** Each warm idle runtime holds a worker process; busy and interactive runtimes are exempt until idle. */
const MAX_IDLE_MANAGED_SESSIONS = 2;

interface AttachManagedSessionOptions {
	autoTitle?: boolean;
	createdAt?: number;
	placeholderTitle?: string;
	resourceRevisionAtCreation: number;
	latestResourceRevision: number;
}

function summarizeManagedSession(managed: ManagedSession): ListedSessionSummary {
	return projectManagedSessionSummary({
		ref: managed.ref,
		runtime: managed.session,
		cwd: managed.cwd,
		createdAt: managed.createdAt,
		placeholderTitle: managed.placeholderTitle,
	});
}

export function createSessionRegistry({
	runtimeProvider,
	extensionUi,
	lifecycleEvents,
	lifecycleOperations,
}: {
	runtimeProvider: SessionRuntimeProvider;
	extensionUi: ExtensionUiBridge;
	lifecycleEvents: SessionLifecycleEvents;
	lifecycleOperations: SessionLifecycleOperations;
}) {
	const {
		clearExtensionUiState,
		getApprovalRequester,
		getExtensionUiRequester,
		registerApprovalRequester,
		registerExtensionUiRequester,
		unregisterApprovalRequester,
		unregisterExtensionUiRequester,
	} = extensionUi;
	const { publishSessionLifecycleFailed, publishSessionTitleChanged } = lifecycleEvents;
	const { hasSessionLifecycleOperation, trackProjectSessionOperation } = lifecycleOperations;
	const { resolveProject: resolveSessionProject } = runtimeProvider;

	/**
	 * Fail-closed teardown for unrecoverable managed-session faults that did not go
	 * through Pi's onLifecycleFailed path (e.g. external JSONL refresh exhaustion).
	 */
	async function failManagedSessionClosed(managed: ManagedSession, error: Error): Promise<void> {
		if (managed.disposing) return;
		const failedRef = managed.ref;
		const relatedRefs = [failedRef];
		const envelope = managed.eventStream.publish(failedRef, {
			type: "runFinished",
			runId: "session-lifecycle",
			outcome: { status: "failed", message: errorMessage(error) },
			timestamp: Date.now(),
		});
		notifyListeners(managed.listeners, "session event", envelope);
		publishSessionLifecycleFailed(failedRef, error, relatedRefs, envelope);
		try {
			await disposeManagedSession(managed);
		} catch (disposeError) {
			log.error(`fail-closed dispose failed for session ${failedRef.sessionId}:`, disposeError);
		}
	}

	const managedSessions = new Map<string, ManagedSession>();
	let managedSessionAccessSequence = 0;
	const replacedRuntimeRefs = createReplacedRuntimeRefIndex();
	const replacementReservations = createSessionReplacementReservations<ManagedSession>({
		extensionUi,
		ownerFor: (ref) => managedSessions.get(sessionKey(ref)),
		targetLifecycleBusy: hasSessionLifecycleOperation,
		commitOwner: (previousRef, nextRef, managed) => {
			const previousKey = sessionKey(previousRef);
			if (previousKey !== sessionKey(nextRef)) managedSessions.delete(previousKey);
			managedSessions.set(sessionKey(nextRef), managed);
		},
	});

	function isManagedSessionCurrent(managed: ManagedSession): boolean {
		return managedSessions.get(sessionKey(managed.ref)) === managed;
	}

	function findManagedSession(ref: SessionRef): ManagedSession | undefined {
		return managedSessions.get(sessionKey(ref));
	}

	function touchManagedSession(managed: ManagedSession): void {
		managedSessionAccessSequence += 1;
		managed.lastAccessSequence = managedSessionAccessSequence;
	}

	function isManagedSessionIdle(managed: ManagedSession): boolean {
		return !managed.disposing && !managed.autoTitleInFlight && !managed.session.isBusy();
	}

	/** Returns the oldest evictable runtimes above the warm idle-set limit. Callers may protect
	 * host-owned interaction state (pending dialogs) that the core deliberately cannot inspect. */
	function listIdleManagedSessionEvictionCandidates(protectedRefs: readonly SessionRef[] = []): SessionRef[] {
		const protectedKeys = new Set(protectedRefs.map(sessionKey));
		const idle = [...managedSessions.values()]
			.filter(
				(managed) =>
					isManagedSessionIdle(managed) &&
					!hasSessionLifecycleOperation(managed.ref) &&
					!protectedKeys.has(sessionKey(managed.ref)),
			)
			.sort((left, right) => left.lastAccessSequence - right.lastAccessSequence);
		const excess = idle.length - MAX_IDLE_MANAGED_SESSIONS;
		if (excess <= 0) return [];
		return idle.slice(0, excess).map((managed) => ({ ...managed.ref }));
	}

	function isManagedSessionRetirable(managed: ManagedSession): boolean {
		// Called from inside the suspension's own registered close operation, so checking the
		// lifecycle registry here would reject that operation itself. The candidate pass fenced
		// competing lifecycle work; this boundary rechecks only current ownership and true idleness.
		return isManagedSessionCurrent(managed) && isManagedSessionIdle(managed);
	}

	function listManagedSessions(): ManagedSession[] {
		return [...managedSessions.values()];
	}

	function listManagedSessionsForProject(cwd: string): ManagedSession[] {
		return [...managedSessions.values()].filter((managed) => managed.cwd === cwd);
	}

	function publishSessionSummaryChanged(managed: ManagedSession): void {
		const {
			sessionFilePath: _sessionFilePath,
			parentSessionFilePath: _parentSessionFilePath,
			manualFork: _manualFork,
			...summary
		} = summarizeManagedSession(managed);
		const envelope = managed.eventStream.publish(managed.ref, { type: "sessionSummaryChanged", summary });
		notifyListeners(managed.listeners, "session event", envelope);
	}

	function startManagedSessionAutoTitle(managed: ManagedSession): void {
		startSessionAutoTitle(managed, {
			isCurrent: isManagedSessionCurrent,
			track: trackProjectSessionOperation,
			publishSummary: publishSessionSummaryChanged,
			publishTitle: lifecycleEvents.publishSessionTitleChanged,
		});
	}

	function clearManagedSessionRef(ref: SessionRef, managed: ManagedSession): void {
		const key = sessionKey(ref);
		const owner = managedSessions.get(key);
		if (owner && owner !== managed) return;
		if (owner === managed) managedSessions.delete(key);
		unregisterApprovalRequester(ref);
		unregisterExtensionUiRequester(ref);
		// Pi keeps the current extension UI context valid through session_shutdown so
		// handlers can tear down statuses/widgets there. Only an already-replaced ref
		// is safe to release here; revoking the current ref would break that cleanup.
		if (sessionKey(managed.session.ref) !== key) managed.session.releaseExtensionUi(ref);
		clearExtensionUiState(ref);
	}

	function attachManagedSession(
		ref: SessionRef,
		session: SessionRuntimePort,
		cwd: string,
		options: AttachManagedSessionOptions,
	): ManagedSession {
		const key = sessionKey(ref);
		replacedRuntimeRefs.forgetPrevious(ref);
		if (managedSessions.has(key) || replacementReservations.has(ref)) {
			throw Object.assign(new Error(`Session is already managed: ${ref.sessionId}`), {
				code: "SESSION_ALREADY_MANAGED" as const,
				ref,
			});
		}
		const extensionUiRequester = getExtensionUiRequester(ref);
		const approvalRequester = getApprovalRequester(ref);
		let managed: ManagedSession;
		const fileSync = createSessionFileSyncController({
			runtime: () => managed.session,
			isCurrent: () => isManagedSessionCurrent(managed),
			sessionId: () => managed.ref.sessionId,
			onSyncFailed: (error) => {
				if (!isManagedSessionCurrent(managed) || managed.disposing) return;
				// Fail-closed: unrecoverable external divergence must not leave a stuck
				// "diverged forever" session. Lifecycle failure tears down managed state
				// and surfaces the error; do not fake an agent runFinished.
				const failure =
					error instanceof Error ? error : new Error("Failed to reload the session file after external changes.");
				void failManagedSessionClosed(managed, failure);
			},
		});
		const resourceReload = createSessionResourceReloadController({
			runtime: () => managed.session,
			isCurrent: () => isManagedSessionCurrent(managed),
			sessionId: () => managed.ref.sessionId,
			track: (operation) => trackProjectSessionOperation(managed.cwd, operation),
			suspendExtensionUiEvents: () => {
				managed.extensionUiEventsSuspended = true;
			},
			resumeExtensionUiEvents: () => resumeManagedExtensionUiEvents(managed, isManagedSessionCurrent),
			appliedRevisionAtCreation: options.resourceRevisionAtCreation,
			latestRevisionAtCreation: options.latestResourceRevision,
		});
		managed = {
			ref,
			session,
			cwd,
			unsubscribeAgent: () => {},
			unsubscribeReplacementCoordinator: () => {},
			unsubscribeReplacement: () => {},
			unsubscribeSnapshotChanged: () => {},
			unsubscribeTranscriptInvalidated: () => {},
			unsubscribeTranscriptProjectionChanged: () => {},
			unsubscribeLifecycleFailure: () => {},
			listeners: new Set(),
			changeReviewListeners: new Set(),
			disposing: false,
			lastAccessSequence: 0,
			createdAt: options.createdAt !== undefined ? options.createdAt : Date.now(),
			placeholderTitle: options.placeholderTitle !== undefined ? options.placeholderTitle : "New session",
			autoTitleEnabled: options.autoTitle === true,
			autoTitleInFlight: false,
			lifecycleEpoch: 0,
			titleRevision: 0,
			commandCatalogRevision: 0,
			extensionUiRevision: 0,
			extensionUiEventsSuspended: false,
			extensionUiChangePending: false,
			commandCatalog: session.listCommands(),
			queue: createSessionQueueController(),
			toolExecutions: [],
			summarizationRetry: null,
			autoRetry: null,
			eventStream: createSessionEventStream(),
			transcriptPager: createTranscriptPager(),
			...(extensionUiRequester ? { extensionUiRequester } : {}),
			...(approvalRequester ? { approvalRequester } : {}),
			fileSync,
			resourceReload,
		};
		touchManagedSession(managed);
		managedSessions.set(key, managed);
		try {
			bindManagedSessionRuntimeEvents(managed, {
				extensionUi,
				lifecycleEvents,
				replacements: replacementReservations,
				isCurrent: isManagedSessionCurrent,
				clearRef: clearManagedSessionRef,
				rememberReplacement: (previousRef, nextRef) => replacedRuntimeRefs.remember(previousRef, nextRef),
				trackProjectOperation: trackProjectSessionOperation,
				publishSummary: publishSessionSummaryChanged,
			});
		} catch (error) {
			managed.lifecycleEpoch += 1;
			disableSessionAutoTitle(managed);
			managed.fileSync.stop();
			managed.unsubscribeLifecycleFailure();
			managed.unsubscribeSnapshotChanged();
			managed.unsubscribeTranscriptInvalidated();
			managed.unsubscribeTranscriptProjectionChanged();
			managed.unsubscribeReplacement();
			managed.unsubscribeReplacementCoordinator();
			managed.unsubscribeAgent();
			replacementReservations.clear(managed);
			clearManagedSessionRef(ref, managed);
			throw error;
		}
		void managed.fileSync.acceptCurrentState();
		managed.resourceReload.triggerAfterCurrent();
		return managed;
	}

	async function disposeManagedSession(managed: ManagedSession): Promise<void> {
		const initialRef = managed.ref;
		// Fence host projections for any in-flight replace that commits during dispose.
		managed.disposing = true;
		disableSessionAutoTitle(managed);
		managed.fileSync.stop();
		managed.unsubscribeAgent();
		managed.unsubscribeSnapshotChanged();
		managed.unsubscribeTranscriptInvalidated();
		managed.unsubscribeTranscriptProjectionChanged();
		managed.transcriptPager.invalidate();
		// Do not bump lifecycleEpoch or abort replacement reservations before dispose.
		// session.dispose() waits for an in-flight replace so its commit can finish; clearing
		// reservations first forced that wait to fail closed (half-switched identity).
		try {
			await managed.queue.drain();
			await managed.resourceReload.drain();
			await managed.session.dispose();
		} finally {
			// Hard suppress anything a concurrent replace might have touched before the fence
			// was observed (belt-and-braces; disposing path should already skip re-arm).
			disableSessionAutoTitle(managed);
			managed.fileSync.stop();
			managed.unsubscribeAgent();
			managed.lifecycleEpoch += 1;
			replacementReservations.clear(managed);
			clearManagedSessionRef(initialRef, managed);
			// Dispose waits for any started replacement. Retain replacement listeners until
			// that wait settles so late reservation cannot bind unmanaged requesters.
			managed.unsubscribeReplacementCoordinator();
			managed.unsubscribeReplacement();
			managed.unsubscribeLifecycleFailure();
			const finalRef = managed.session.ref;
			if (sessionKey(finalRef) !== sessionKey(initialRef)) clearManagedSessionRef(finalRef, managed);
		}
	}

	function setExtensionUiRequester(ref: SessionRef, requester: ExtensionUiRequester): void {
		const managed = managedSessions.get(sessionKey(ref));
		if (managed) managed.extensionUiRequester = requester;
		registerExtensionUiRequester(ref, requester);
	}

	function setApprovalRequester(ref: SessionRef, requester: ApprovalRequester): void {
		const managed = managedSessions.get(sessionKey(ref));
		if (managed) managed.approvalRequester = requester;
		registerApprovalRequester(ref, requester);
	}

	function requireRegisteredSession(ref: SessionRef): ManagedSession {
		const managed = managedSessions.get(sessionKey(ref));
		if (managed) return managed;
		throw createLingError({
			code: "SESSION_NOT_FOUND",
			category: "lifecycle",
			message: `Unknown session: ${ref.sessionId}`,
			retryable: true,
			userAction: "reopenProject",
			details: { sessionId: ref.sessionId },
		});
	}

	function onSessionEvent(ref: SessionRef, listener: SessionEventListener): () => void {
		const managed = requireRegisteredSession(ref);
		managed.listeners.add(listener);
		return () => managed.listeners.delete(listener);
	}

	function onSessionChangeReviewEvent(ref: SessionRef, listener: SessionChangeReviewEventListener): () => void {
		const managed = requireRegisteredSession(ref);
		managed.changeReviewListeners.add(listener);
		return () => managed.changeReviewListeners.delete(listener);
	}

	/** Extension state may arrive while Pi is binding or disposing a rejected runtime. */
	function tryCreateExtensionUiChangedEnvelope(ref: SessionRef): SessionEventEnvelope | null {
		const managed = managedSessions.get(sessionKey(ref));
		if (!managed) return null;
		if (managed.extensionUiEventsSuspended) {
			managed.extensionUiChangePending = true;
			return null;
		}
		return publishManagedExtensionUiChanged(managed);
	}

	function requireManagedSession(ref: SessionRef): ManagedSession {
		const managed = managedSessions.get(sessionKey(ref));
		if (!managed) {
			const replacementRef = replacedRuntimeRefs.find(ref);
			if (replacementRef) {
				throw createLingError({
					code: "STALE_RUNTIME_GENERATION",
					category: "lifecycle",
					message: "The request targets a session runtime that has been replaced.",
					retryable: true,
					userAction: "retry",
					details: { previousSessionId: ref.sessionId, replacementSessionId: replacementRef.sessionId },
				});
			}
			throw createLingError({
				code: "SESSION_NOT_FOUND",
				category: "lifecycle",
				message: `Unknown session: ${ref.sessionId}`,
				retryable: true,
				userAction: "reopenProject",
				details: { sessionId: ref.sessionId },
			});
		}
		resolveSessionProject(managed.cwd);
		touchManagedSession(managed);
		return managed;
	}

	function hasReplacedSessionRuntime(ref: SessionRef): boolean {
		return replacedRuntimeRefs.find(ref) !== undefined;
	}

	async function renameSession(ref: SessionRef, title: string): Promise<void> {
		const trimmed = normalizeLingSessionTitle(title);
		const managed = requireManagedSession(ref);
		const restoreAutoTitle = managed.autoTitleEnabled;
		const titleRevision = managed.titleRevision + 1;
		managed.titleRevision = titleRevision;
		disableSessionAutoTitle(managed);
		try {
			await managed.session.setSessionName(trimmed);
		} catch (error) {
			if (
				!managed.disposing &&
				managed.titleRevision === titleRevision &&
				sessionKey(managed.ref) === sessionKey(ref) &&
				isManagedSessionCurrent(managed)
			) {
				managed.autoTitleEnabled = restoreAutoTitle;
				managed.autoTitleInFlight = false;
				if (restoreAutoTitle) startManagedSessionAutoTitle(managed);
			}
			throw error;
		}
		if (
			managed.disposing ||
			managed.titleRevision !== titleRevision ||
			sessionKey(managed.ref) !== sessionKey(ref) ||
			!isManagedSessionCurrent(managed)
		) {
			return;
		}
		void managed.fileSync.acceptCurrentState();
		managed.placeholderTitle = trimmed;
		publishSessionTitleChanged(managed.ref, trimmed);
		publishSessionSummaryChanged(managed);
	}

	function clearSessionRegistryProject(cwd: string): void {
		replacedRuntimeRefs.clearProject(cwd);
	}

	function clearSessionRegistryIdentity(ref: SessionRef): void {
		replacedRuntimeRefs.clearSession(ref);
	}
	return {
		isManagedSessionCurrent,
		findManagedSession,
		touchManagedSession,
		listIdleManagedSessionEvictionCandidates,
		isManagedSessionRetirable,
		listManagedSessions,
		listManagedSessionsForProject,
		summarizeManagedSession,
		startManagedSessionAutoTitle,
		attachManagedSession,
		disposeManagedSession,
		setExtensionUiRequester,
		setApprovalRequester,
		onSessionEvent,
		onSessionChangeReviewEvent,
		tryCreateExtensionUiChangedEnvelope,
		requireManagedSession,
		hasReplacedSessionRuntime,
		renameSession,
		clearSessionRegistryProject,
		clearSessionRegistryIdentity,
	};
}

export type SessionRegistry = ReturnType<typeof createSessionRegistry>;
