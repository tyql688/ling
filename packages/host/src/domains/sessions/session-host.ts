import type { SessionRef, SessionRuntimeSuspendedEvent } from "@ling/contracts/session";
import type { CompanionRunRequest } from "@ling/contracts/companions";
import { sessionProcedures } from "@ling/contracts/session-procedures";
import { uniqueSessionRefs } from "@ling/contracts/session-ref";
import type { ExtensionUiBridge } from "@ling/core/pi-protocol/extension-ui";
import { attemptCleanup, throwAggregateFailures, toError } from "@ling/core/ling-error";
import { createLogger } from "@ling/core/logger";
import type { ManagedSessionManager } from "@ling/host/domains/sessions/manager/session-manager";
import type { HostClientState } from "../../transport/client-state";
import type { HostEventPublisher } from "../../transport/event-bus";
import type { HostShellActivity } from "../../transport/shell-activity";
import type { ChangeReviewHost } from "../review/change-review";
import type { ChangeReviewOperationRegistry } from "../review/operations";
import type { ComposerHistory } from "./composer-history";
import { createSessionOperationRegistry } from "./operations";
import type { SessionCatalogStore } from "./session-catalog";
import { createSessionDialogHost } from "./session-dialog-host";
import { createSessionEventBridgeHost } from "./session-event-bridge";
import { registerSessionLifecycleHost } from "./session-lifecycle-host";
import { createSessionListCache } from "./session-list-cache";
import { createSessionRuntimeRetentionHost } from "./session-runtime-retention";

const log = createLogger("session-host");

interface SessionHostOptions {
	catalog: SessionCatalogStore;
	composerHistory: ComposerHistory;
	manager: ManagedSessionManager;
	extensionUi: ExtensionUiBridge;
	review: ChangeReviewHost;
	reviewOperations: ChangeReviewOperationRegistry;
	events: HostEventPublisher;
	clients: HostClientState;
	shellActivity: HostShellActivity;
	pendingInteractionRefs(): SessionRef[];
}

/** Owns session interaction, event forwarding and retirement for one Host lifetime.
 * Project transactions receive its lifecycle methods directly; request registration owns no runtime state. */
export function createSessionHost({
	events,
	clients,
	shellActivity,
	review,
	reviewOperations,
	manager,
	extensionUi,
	catalog,
	composerHistory,
	pendingInteractionRefs,
}: SessionHostOptions) {
	const { resumeSession, closeSessionsForProject } = manager;
	const listCache = createSessionListCache(manager, catalog);

	const sessionOperations = createSessionOperationRegistry();
	const { releaseChangeReviewSession } = review;
	const changeReviewDiffOperations = reviewOperations;
	const pendingReviewReleases = new Set<Promise<void>>();
	let stopping = false;
	/** Drops review state for sessions whose event bridges have already been detached. */
	async function releaseSessionReviewState(refs: readonly SessionRef[]): Promise<unknown[]> {
		const released = await Promise.allSettled(refs.map((ref) => releaseChangeReviewSession(ref)));
		return released.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
	}

	async function unsubscribeSessionEvents(refs: readonly SessionRef[]): Promise<void> {
		const uniqueRefs = uniqueSessionRefs(refs);
		retention.forget(uniqueRefs);
		const failures = [...eventBridge.release(uniqueRefs), ...(await releaseSessionReviewState(uniqueRefs))];
		throwAggregateFailures(failures, "Failed to unsubscribe session events");
	}

	/** Recreates every runtime and main-process bridge removed by a project-close transaction.
	 * The preliminary cleanup is intentionally idempotent: a failed close may leave an old
	 * forwarder behind even though its managed runtime was already disposed. */
	async function restoreSessionRuntimesAndEvents(refs: readonly SessionRef[]): Promise<void> {
		const uniqueRefs = uniqueSessionRefs(refs);
		const bridgeFailures = eventBridge.release(uniqueRefs);
		const reviewFailures = await releaseSessionReviewState(uniqueRefs);
		if (reviewFailures.length > 0) {
			log.error(
				"session rollback review-cache cleanup failed:",
				new AggregateError(reviewFailures, "Failed to release session review state"),
			);
		}
		throwAggregateFailures(bridgeFailures, "Failed to detach session event bridges before rollback");

		const restored = await Promise.allSettled(
			uniqueRefs.map(async (ref) => {
				await resumeSession(ref, {
					beforeBind: (boundRef) => dialogs.bind(boundRef),
				});
				eventBridge.bind(ref);
			}),
		);
		const failures = restored.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
		if (failures.length === 1) {
			const [failure] = failures;
			throw toError(failure);
		}
		if (failures.length > 1) throw new AggregateError(failures, "Failed to restore project sessions");
	}

	function releaseSessionEventBridges(refs: readonly SessionRef[]): void {
		const uniqueRefs = uniqueSessionRefs(refs);
		const failures = eventBridge.release(uniqueRefs);
		if (failures.length === 0) return;
		log.error(
			"session event bridge release failed:",
			failures.length === 1 ? failures[0] : new AggregateError(failures, "Failed to release session event bridges"),
		);
	}

	function releaseSessionReviewInBackground(refs: readonly SessionRef[]): void {
		const uniqueRefs = uniqueSessionRefs(refs);
		const release: Promise<void> = releaseSessionReviewState(uniqueRefs)
			.then((failures) => {
				throwAggregateFailures(failures, "Failed to release session review state");
			})
			.finally(() => pendingReviewReleases.delete(release));
		pendingReviewReleases.add(release);
		void release.catch((error: unknown) => {
			log.error("session review-state cleanup failed:", error);
		});
	}

	/** Cancel every session + change-review op for the given project identity. */
	function cancelProjectSessionOperations(cwd: string, reason: string): void {
		sessionOperations.cancelByProject(cwd, reason);
		changeReviewDiffOperations.cancelByProject(cwd, reason);
	}

	function cancelAllSessionOperations(reason: string): void {
		sessionOperations.cancelAll(reason);
		changeReviewDiffOperations.cancelAll(reason);
	}

	const dialogs = createSessionDialogHost(events, clients, { registry: manager.registry, extensionUi, shellActivity });
	const eventBridge = createSessionEventBridgeHost({
		registry: manager.registry,
		review,
		events,
		shellActivity,
		dialogs,
		cancelSessionOperations: (ref) => sessionOperations.cancelByRef(ref, "transcriptInvalidated"),
		onSessionMayBeIdle: () => retention.reap(),
	});
	const retention = createSessionRuntimeRetentionHost({
		manager,
		pendingInteractionRefs: () => [
			...pendingInteractionRefs(),
			...dialogs.pendingApprovals().map((request) => request.ref),
			...dialogs.pendingExtensionUi().map((request) => request.ref),
		],
		onSuspending: (ref) => {
			sessionOperations.cancelByRef(ref, "sessionRuntimeSuspended");
			changeReviewDiffOperations.cancelByRef(ref, "sessionRuntimeSuspended");
			releaseSessionEventBridges([ref]);
			releaseSessionReviewInBackground([ref]);
		},
		onSuspended: (ref, retentionRevision) => {
			const event: SessionRuntimeSuspendedEvent = { ref, retentionRevision, reason: "idle" };
			events.broadcast(sessionProcedures.onRuntimeSuspended.channel, event);
		},
	});
	const disposeLifecycleHost = registerSessionLifecycleHost({
		manager,
		extensionUi,
		reviewOperations,
		events,
		shellActivity,
		eventBridge,
		cancelSessionOperations: (ref, reason) => sessionOperations.cancelByRef(ref, reason),
		releaseSessionEventBridges,
		releaseSessionReviewInBackground,
		onSessionRuntimesFailed: (refs) => {
			for (const retired of retention.retire(refs)) {
				const event: SessionRuntimeSuspendedEvent = { ...retired, reason: "failed" };
				events.broadcast(sessionProcedures.onRuntimeSuspended.channel, event);
			}
		},
		onSessionRuntimeReplaced: (previousRef, nextRef) => {
			if (stopping) return;
			retention.forget([previousRef]);
			retention.retain(nextRef);
		},
	});

	let disposal: Promise<void> | null = null;
	return {
		/** Resumes or creates the session an automatic run targets, bound and retained like a user-opened one. */
		async prepareCompanionSession(input: CompanionRunRequest) {
			if (stopping) throw new Error("Session admission is stopping");
			let ref: SessionRef;
			if (input.sessionId) {
				ref = { cwd: input.cwd, sessionId: input.sessionId };
				await manager.resumeSession(ref, { beforeBind: (bound) => dialogs.bind(bound) });
			} else {
				const summary = await manager.createSession(input.cwd, input.title, {
					beforeBind: (bound) => dialogs.bind(bound),
					...(input.model ? { model: input.model } : {}),
					...(input.thinking ? { thinkingLevel: input.thinking } : {}),
				});
				ref = { cwd: summary.cwd, sessionId: summary.id };
			}
			eventBridge.bind(ref);
			retention.retain(ref);
			listCache.invalidate();
			events.broadcast(sessionProcedures.onCatalogChanged.channel, { type: "changed" });
			return manager.registry.requireManagedSession(ref).session;
		},
		manager,
		catalog,
		composerHistory,
		listCache,
		closeSessionsForProject,
		operations: sessionOperations,
		reviewOperations,
		dialogs,
		eventBridge,
		retention,
		unsubscribeSessionEvents,
		restoreSessionRuntimesAndEvents,
		cancelProjectSessionOperations,
		cancelAllSessionOperations,
		prepareShutdown() {
			stopping = true;
			retention.prepareShutdown();
			listCache.prepareShutdown();
			cancelAllSessionOperations("appShutdown");
		},
		dispose(): Promise<void> {
			if (disposal) return disposal;
			const settlement = Promise.withResolvers<void>();
			disposal = settlement.promise;
			stopping = true;
			const failures: unknown[] = [];
			attemptCleanup(failures, disposeLifecycleHost);
			attemptCleanup(failures, () => cancelAllSessionOperations("sessionHostDisposed"));
			attemptCleanup(failures, () => {
				failures.push(...eventBridge.dispose());
			});
			attemptCleanup(failures, dialogs.dispose);
			void Promise.allSettled([...pendingReviewReleases, retention.dispose(), listCache.dispose()]).then((results) => {
				for (const result of results) if (result.status === "rejected") failures.push(result.reason);
				if (failures.length > 0)
					settlement.reject(new AggregateError(failures, "Failed to dispose session Host owners"));
				else settlement.resolve();
			});
			return disposal;
		},
	};
}

export type SessionHost = ReturnType<typeof createSessionHost>;
