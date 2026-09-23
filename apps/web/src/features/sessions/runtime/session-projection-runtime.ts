import { SessionMessageDeltaMismatch } from "@ling/contracts/session-message-delta";
import type { LingApi } from "@ling/contracts/api/ling-api";
import type { SessionEventEnvelope } from "@ling/contracts/session";
import { toError } from "@ling/contracts/ling-error";
import type { SessionRef } from "@ling/contracts/session-ref";
import { sessionKey } from "@ling/contracts/session-ref";
import {
	captureRendererSessionState,
	hibernateRendererSessionState,
	isRendererSessionStateCurrent,
	onRendererSessionStateEvicted,
	retireReplacedRendererSessionState,
	wakeRendererSessionState,
} from "@renderer/features/sessions/runtime/renderer-session-state";
import {
	createLatestCompanionRequestQueue,
	type LatestCompanionRequestQueue,
	sameCommandCatalogTarget,
	sameExtensionUiTarget,
	selectCompanionSnapshot,
	type SessionCompanionTarget,
} from "@renderer/features/sessions/runtime/session-companion-controller";
import {
	createSessionMessageUpdateBatcher,
	type ScheduleSessionMessageUpdateFlush,
} from "@renderer/features/sessions/runtime/session-message-update-batcher";
import { sessionStreamController } from "@renderer/features/sessions/runtime/session-stream-controller";
import { markTranscriptKnownEmpty } from "@renderer/features/sessions/runtime/session-transcript-projection";
import { appendUnsentMessages } from "@renderer/features/sessions/state/composer-message";
import { draftsAtom, EMPTY_DRAFT } from "@renderer/features/sessions/state/drafts";
import {
	activeSessionRefAtom,
	commandCatalogSnapshotFamily,
	extensionUiSnapshotFamily,
	sessionErrorFamily,
	sessionErrorMessageFamily,
	sessionTranscriptStateFamily,
} from "@renderer/features/sessions/state/session";
import { isExpectedCompanionRace } from "@renderer/lib/errors";
import i18next from "i18next";
import type { createStore } from "jotai/vanilla";
import { sessionViewFamily } from "../state/session";
import { reduceSessionView } from "./session-view";

type Store = ReturnType<typeof createStore>;

const scheduleMessageUpdateFlush: ScheduleSessionMessageUpdateFlush = (callback) => {
	let finished = false;
	const finish = (): void => {
		if (finished) return;
		finished = true;
		window.cancelAnimationFrame(frame);
		window.clearTimeout(timeout);
		callback();
	};
	const frame = window.requestAnimationFrame(finish);
	const timeout = window.setTimeout(finish, 16);
	return () => {
		if (finished) return;
		finished = true;
		window.cancelAnimationFrame(frame);
		window.clearTimeout(timeout);
	};
};

/** Every active session keeps its Host event subscription when the user switches away from it.
 * Keep the renderer cache updated for all sessions, not just the visible one, so background turns
 * continue to stream and do not look frozen when the user switches back. */
export function createSessionProjectionRuntime(store: Store, session: LingApi["session"]) {
	const pendingRefreshes = new Map<string, Promise<void>>();
	const companionRequests = new Map<string, LatestCompanionRequestQueue<SessionCompanionTarget>>();
	let disposed = false;

	const requestCommandCatalog = (ref: SessionRef, target: SessionCompanionTarget): void => {
		const key = sessionKey(ref);
		const requestKey = `${key}:commands`;
		let queue = companionRequests.get(requestKey);
		if (!queue) {
			queue = createLatestCompanionRequestQueue(
				async (requestedTarget) => {
					const stateToken = captureRendererSessionState(key);
					let result: Awaited<ReturnType<typeof session.readCommandCatalog>>;
					try {
						result = await session.readCommandCatalog({
							ref,
							runtimeId: requestedTarget.runtimeId,
							generation: requestedTarget.generation,
							expectedRevision: requestedTarget.commandCatalogRevision,
						});
					} catch (error) {
						if (
							!disposed &&
							isRendererSessionStateCurrent(key, stateToken) &&
							sameCommandCatalogTarget(sessionStreamController.getPosition(key), requestedTarget) &&
							!isExpectedCompanionRace(error)
						)
							store.set(sessionErrorFamily(key), true);
						return;
					}
					if (disposed || !isRendererSessionStateCurrent(key, stateToken)) return;
					const currentTarget = sessionStreamController.getPosition(key);
					if (!sameCommandCatalogTarget(currentTarget, requestedTarget)) return;
					store.set(commandCatalogSnapshotFamily(key), (current) =>
						selectCompanionSnapshot(current, result, ref, requestedTarget, requestedTarget.commandCatalogRevision),
					);
				},
				sameCommandCatalogTarget,
				() => {
					if (!disposed && sessionStreamController.getPosition(key)) store.set(sessionErrorFamily(key), true);
				},
			);
			companionRequests.set(requestKey, queue);
		}
		queue.schedule(target);
	};

	const requestExtensionUi = (ref: SessionRef, target: SessionCompanionTarget): void => {
		const key = sessionKey(ref);
		const requestKey = `${key}:extensionUi`;
		let queue = companionRequests.get(requestKey);
		if (!queue) {
			queue = createLatestCompanionRequestQueue(
				async (requestedTarget) => {
					const stateToken = captureRendererSessionState(key);
					let result: Awaited<ReturnType<typeof session.readExtensionUiState>>;
					try {
						result = await session.readExtensionUiState({
							ref,
							runtimeId: requestedTarget.runtimeId,
							generation: requestedTarget.generation,
							expectedRevision: requestedTarget.extensionUiRevision,
						});
					} catch (error) {
						if (
							!disposed &&
							isRendererSessionStateCurrent(key, stateToken) &&
							sameExtensionUiTarget(sessionStreamController.getPosition(key), requestedTarget) &&
							!isExpectedCompanionRace(error)
						)
							store.set(sessionErrorFamily(key), true);
						return;
					}
					if (disposed || !isRendererSessionStateCurrent(key, stateToken)) return;
					const currentTarget = sessionStreamController.getPosition(key);
					if (!sameExtensionUiTarget(currentTarget, requestedTarget)) return;
					store.set(extensionUiSnapshotFamily(key), (current) =>
						selectCompanionSnapshot(current, result, ref, requestedTarget, requestedTarget.extensionUiRevision),
					);
				},
				sameExtensionUiTarget,
				() => {
					if (!disposed && sessionStreamController.getPosition(key)) store.set(sessionErrorFamily(key), true);
				},
			);
			companionRequests.set(requestKey, queue);
		}
		queue.schedule(target);
	};

	const requestCompanions = (ref: SessionRef): void => {
		const target = sessionStreamController.getPosition(sessionKey(ref));
		if (!target) return;
		requestCommandCatalog(ref, target);
		requestExtensionUi(ref, target);
	};

	const applyEnvelope = (key: string, envelope: SessionEventEnvelope) => {
		store.set(sessionViewFamily(key), (current) => reduceSessionView(current, { type: "event", envelope }));
		if (
			envelope.event.type === "runFinished" &&
			envelope.event.outcome.status === "failed" &&
			envelope.event.outcome.restoredMessages !== undefined &&
			envelope.event.outcome.restoredMessages.length > 0
		) {
			// Queued messages the failed run never sent come back to the composer, like an abort.
			const drafts = store.get(draftsAtom);
			const restored = appendUnsentMessages(drafts[key] ?? EMPTY_DRAFT, envelope.event.outcome.restoredMessages);
			store.set(draftsAtom, { ...drafts, [key]: restored.draft });
			if (restored.omitted > 0) {
				store.set(sessionErrorMessageFamily(key), (message) =>
					[message, i18next.t("session.queuedRestoreLimit", { count: restored.omitted })].filter(Boolean).join("\n"),
				);
			}
		}
	};

	const messageUpdateBatcher = createSessionMessageUpdateBatcher({
		schedule: scheduleMessageUpdateFlush,
		onFlush(key, envelopes) {
			try {
				store.set(sessionViewFamily(key), (current) =>
					envelopes.reduce((view, envelope) => reduceSessionView(view, { type: "event", envelope }), current),
				);
			} catch (error) {
				if (!(error instanceof SessionMessageDeltaMismatch)) throw error;
				// Keep the visible transcript while replacing a missing delta baseline with an authoritative snapshot.
				messageUpdateBatcher.discard(key);
				sessionStreamController.reset(key);
				const target = envelopes.at(-1);
				if (!target) throw error;
				requestSnapshot(target.ref);
			}
		},
	});

	const projectEnvelope = (key: string, envelope: SessionEventEnvelope): void => {
		if (envelope.event.type === "messageUpdate" || envelope.event.type === "messageDelta") {
			messageUpdateBatcher.enqueue(key, envelope);
			return;
		}
		messageUpdateBatcher.flush(key);
		applyEnvelope(key, envelope);
	};

	const resetProjection = (key: string, type: "clear" | "clearTranscript" | "rollover") => {
		messageUpdateBatcher.discard(key);
		store.set(sessionViewFamily(key), (current) => reduceSessionView(current, { type }));
	};

	const dirtyRefreshes = new Set<string>();
	const requestSnapshot = (ref: SessionRef): void => {
		if (disposed) return;
		const key = sessionKey(ref);
		// Coalesce concurrent refresh requests, but never drop a later generation: if
		// another resync arrives while getSnapshot is in flight, re-run after it settles.
		if (pendingRefreshes.has(key)) {
			dirtyRefreshes.add(key);
			return;
		}
		const stateToken = captureRendererSessionState(key);
		const transcriptState = store.get(sessionTranscriptStateFamily(key));
		const transcriptCache =
			transcriptState.hydrationSettled && !transcriptState.hasOlder && transcriptState.transcriptCacheKey !== null
				? {
						cacheKey: transcriptState.transcriptCacheKey,
						runtimeId: transcriptState.runtimeId,
						generation: transcriptState.generation,
						transcriptRevision: transcriptState.currentRevision,
					}
				: undefined;
		const request = session
			.getSnapshot({ ref, ...(transcriptCache === undefined ? {} : { transcriptCache }) })
			.then((result) => {
				if (disposed || !isRendererSessionStateCurrent(key, stateToken)) return;
				const snapshot = result;
				const decision = sessionStreamController.acceptSnapshot(key, snapshot);
				// Snapshot is authoritative (apply | ignore only) — no resync loop.
				// ignore includes "stale snapshot vs newer buffered binding" after replace.
				if (decision.type === "ignore") return;
				messageUpdateBatcher.discard(key);
				store.set(sessionViewFamily(key), (current) =>
					reduceSessionView(current, { type: "snapshot", snapshot: decision.snapshot }),
				);
				for (const buffered of decision.bufferedEvents) projectEnvelope(key, buffered);
				requestCompanions(ref);
			})
			.catch(() => {
				if (!disposed && isRendererSessionStateCurrent(key, stateToken)) store.set(sessionErrorFamily(key), true);
			})
			.finally(() => {
				if (pendingRefreshes.get(key) === request) pendingRefreshes.delete(key);
				if (disposed || !isRendererSessionStateCurrent(key, stateToken)) {
					dirtyRefreshes.delete(key);
					return;
				}
				if (!dirtyRefreshes.has(key)) return;
				dirtyRefreshes.delete(key);
				requestSnapshot(ref);
			});
		pendingRefreshes.set(key, request);
	};
	const ensureSnapshot = (ref: SessionRef): void => {
		if (pendingRefreshes.has(sessionKey(ref))) return;
		requestSnapshot(ref);
	};

	const autoResumedFailures = new Set<string>();
	const cleanups: Array<() => void> = [];
	const dispose = () => {
		if (disposed) return;
		disposed = true;
		const failures: Error[] = [];
		const owned = [
			messageUpdateBatcher.dispose,
			...[...companionRequests.values()].map((queue) => () => queue.dispose()),
			...cleanups.splice(0),
		];
		for (const cleanup of owned) {
			try {
				cleanup();
			} catch (error) {
				failures.push(toError(error));
			}
		}
		companionRequests.clear();
		pendingRefreshes.clear();
		dirtyRefreshes.clear();
		if (failures.length > 0) throw new AggregateError(failures, "Session projection cleanup failed");
	};
	try {
		cleanups.push(
			onRendererSessionStateEvicted((keys) => {
				for (const key of keys) {
					messageUpdateBatcher.discard(key);
					pendingRefreshes.delete(key);
					dirtyRefreshes.delete(key);
					for (const suffix of ["commands", "extensionUi"] as const) {
						const requestKey = `${key}:${suffix}`;
						companionRequests.get(requestKey)?.dispose();
						companionRequests.delete(requestKey);
					}
				}
			}),
		);

		cleanups.push(
			session.onEvent((envelope) => {
				const key = sessionKey(envelope.ref);
				if (envelope.event.type === "sessionReplaced") {
					const previousKey = sessionKey(envelope.event.previousRef);
					// A same-file refresh reuses the key: the session is still live, so wiping its
					// busy/queue state here would contradict main. The stream controller reset is
					// still required — the event stream rolled over to a new runtime generation.
					const sameSession = previousKey === key;
					if (sameSession) {
						messageUpdateBatcher.discard(previousKey);
						for (const suffix of ["commands", "extensionUi"] as const) {
							const requestKey = `${previousKey}:${suffix}`;
							companionRequests.get(requestKey)?.dispose();
							companionRequests.delete(requestKey);
						}
						sessionStreamController.reset(previousKey);
						// In-flight getSnapshot for the previous generation is stale; the
						// coalesced finally path re-fetches after this replacement envelope.
						dirtyRefreshes.add(key);
						// Companion snapshots are kept, not nulled: requestCompanions re-reads both for
						// the new generation, and selectCompanionSnapshot only keeps a current snapshot
						// when the runtime binding matches, so the fresh read always wins. Nulling them
						// empties the extension dock badge and the command catalog for the frames in
						// between, which collapses the workspace tool badge and re-expands it.
						resetProjection(previousKey, "rollover");
					} else {
						retireReplacedRendererSessionState(store, envelope.event.previousRef, envelope.ref);
					}
					if (envelope.event.reason === "new") {
						store.set(sessionTranscriptStateFamily(key), markTranscriptKnownEmpty);
					}
				}
				const decision = sessionStreamController.acceptEnvelope(key, envelope);
				if (decision.type === "ignore") return;
				if (decision.type === "resync") {
					messageUpdateBatcher.discard(key);
					if (decision.clearProjection) resetProjection(key, "clear");
					// Events delivered by the snapshot boundary can arrive while the first snapshot is
					// still in flight. They are already buffered for acceptSnapshot to replay, so marking
					// that request dirty would project the entire transcript again after it succeeds.
					if (decision.reason !== "uninitialized" || !pendingRefreshes.has(key)) {
						requestSnapshot(envelope.ref);
					}
					return;
				}
				projectEnvelope(key, decision.envelope);
				const target = sessionStreamController.getPosition(key);
				if (target && envelope.event.type === "commandsChanged") requestCommandCatalog(envelope.ref, target);
				if (target && envelope.event.type === "extensionUiChanged") requestExtensionUi(envelope.ref, target);
				// Ordinary snapshot changes include every persisted transcript entry. Keep the live
				// projection visible and merge the authoritative tail when it arrives; clearing here
				// makes an active new session fall back behind the history-loading gate on every write.
				// Explicit invalidation is the protocol signal for branch/reload/source rewrites.
				if (envelope.event.type === "transcriptInvalidated") {
					// Compaction is append-only: Pi writes a `compaction` entry carrying `parentId` and
					// `firstKeptEntryId`, and every older entry stays on the chain (only the context handed
					// to the model is trimmed). So the projection is still correct and clearing it is pure
					// loss: the refill needs one page per 200 entries, and every streamed delta bumps
					// transcriptRevision, which drops the pager's pinned view and kills the in-flight
					// cursor — a long session can never finish that refill until the turn goes quiet.
					// Tree navigation and reload do rewrite the chain, so those still drop the projection.
					if (envelope.event.reason !== "compaction") resetProjection(key, "clearTranscript");
					requestSnapshot(envelope.ref);
				} else if (envelope.event.type === "snapshotChanged" || envelope.event.type === "transcriptProjectionChanged") {
					requestSnapshot(envelope.ref);
				}
			}),
		);
		cleanups.push(
			session.onRuntimeSuspended(({ ref, retentionRevision, reason }) => {
				hibernateRendererSessionState(store, ref, retentionRevision);
				if (reason !== "failed") return;
				const key = sessionKey(ref);
				const active = store.get(activeSessionRefAtom);
				if (!active || sessionKey(active) !== key) return;
				const deselect = () =>
					store.set(activeSessionRefAtom, (current) => (current && sessionKey(current) === key ? null : current));
				// A lost worker affects only this session. The visible session comes back once on its
				// own; a second loss hands control back so a broken session cannot restart forever.
				if (autoResumedFailures.has(key)) {
					autoResumedFailures.delete(key);
					deselect();
					return;
				}
				autoResumedFailures.add(key);
				void session
					.resume({ ref })
					.then(({ retentionRevision: revived }) => {
						const stillActive = store.get(activeSessionRefAtom);
						if (disposed || !stillActive || sessionKey(stillActive) !== key) return;
						wakeRendererSessionState(store, ref, revived);
						ensureSnapshot(ref);
					})
					.catch(deselect);
			}),
		);
	} catch (error) {
		try {
			dispose();
		} catch (cleanupError) {
			throw new AggregateError(
				[toError(error), toError(cleanupError)],
				"Session projection startup and cleanup failed",
			);
		}
		throw error;
	}
	return { refresh: ensureSnapshot, dispose };
}
