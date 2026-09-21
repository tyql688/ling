import { toError } from "../../ling-error";
import type { SessionRef } from "@ling/contracts/session";
import { sessionKey, uniqueSessionRefs } from "@ling/contracts/session-ref";
import type {
	SessionRuntimeReplacementCoordinator,
	SessionRuntimeReplacementEvent,
	SessionRuntimeReplacementReason,
	SessionRuntimeReplacementReservation,
} from "@ling/core/pi-protocol/runtime-types";
import { createLogger } from "../../logger";
import { type PiSessionLifecycleState, sessionLifecycleConflict, sessionReplacementBusy } from "./runtime-lifecycle";

const log = createLogger("pi-runtime-replacement");

type ReplacementListener = (event: SessionRuntimeReplacementEvent) => void;
type LifecycleFailureListener = (ref: SessionRef, error: unknown, relatedRefs: readonly SessionRef[]) => void;

interface ActiveSessionReplacement {
	reason: SessionRuntimeReplacementReason;
	previousRef: SessionRef;
	invalidated: boolean;
	reservation: SessionRuntimeReplacementReservation | null;
	reservedEvent: SessionRuntimeReplacementEvent | null;
	candidateRef: SessionRef | null;
}

interface RuntimeReplacementHost {
	getActiveResourceReload(): Promise<void> | null;
	getOperationCounts(): {
		active: number;
		activePrompts: number;
		pendingMutations: number;
	};
	assertRuntimeHealthy(): void;
	disposeInvalidatedRuntime(): Promise<void>;
	emitSnapshotChanged(): void;
	emitDeferredResourceReloadIdleEdge(): void;
}

interface PreparedRuntimeBinding {
	commit(): Promise<void>;
}

interface RuntimeReplacementSnapshot {
	lifecycle: PiSessionLifecycleState;
	replacementListeners: number;
	lifecycleFailureListeners: number;
	replacementCoordinatorOwned: boolean;
}

interface PiRuntimeReplacement {
	readonly ref: SessionRef;
	readonly lifecycle: PiSessionLifecycleState;
	readonly active: Promise<unknown> | null;
	readonly generationBound: boolean;
	snapshot(): RuntimeReplacementSnapshot;
	onReplaced(listener: ReplacementListener): () => void;
	onLifecycleFailed(listener: LifecycleFailureListener): () => void;
	setCoordinator(coordinator: SessionRuntimeReplacementCoordinator): () => void;
	setLifecycle(state: PiSessionLifecycleState): void;
	markGenerationInvalidated(): void;
	prepareBinding(nextRef: SessionRef): Promise<PreparedRuntimeBinding | null>;
	replace<Result>(
		reason: SessionRuntimeReplacementReason,
		targetRef: SessionRef | null,
		replace: () => Promise<Result>,
		allowOwningPrompt?: boolean,
	): Promise<Result>;
	emitLifecycleFailure(error: unknown, relatedRefs?: readonly SessionRef[]): void;
}

export function createPiRuntimeReplacement(initialRef: SessionRef, host: RuntimeReplacementHost): PiRuntimeReplacement {
	let currentRef = initialRef;
	let lifecycle: PiSessionLifecycleState = "active";
	let active: Promise<unknown> | null = null;
	let generationBound = false;
	let coordinator: SessionRuntimeReplacementCoordinator | null = null;
	let context: ActiveSessionReplacement | null = null;
	const replacementListeners = new Set<ReplacementListener>();
	const lifecycleFailureListeners = new Set<LifecycleFailureListener>();

	const emitLifecycleFailure = (error: unknown, relatedRefs: readonly SessionRef[] = [currentRef]): void => {
		for (const listener of lifecycleFailureListeners) {
			try {
				listener(currentRef, error, relatedRefs);
			} catch (listenerError) {
				log.error(`lifecycle failure listener failed for session ${currentRef.sessionId}:`, listenerError);
			}
		}
	};
	const reserve = async (
		replacement: ActiveSessionReplacement,
		event: SessionRuntimeReplacementEvent,
	): Promise<void> => {
		if (replacement.reservedEvent) {
			if (sessionKey(replacement.reservedEvent.nextRef) !== sessionKey(event.nextRef)) {
				throw new Error(
					`Replacement target changed from ${replacement.reservedEvent.nextRef.sessionId} to ${event.nextRef.sessionId}`,
				);
			}
			return;
		}
		replacement.reservedEvent = event;
		replacement.reservation = coordinator ? await coordinator(event) : null;
	};

	const replacement: PiRuntimeReplacement = {
		get ref() {
			return currentRef;
		},
		get lifecycle() {
			return lifecycle;
		},
		get active() {
			return active;
		},
		get generationBound() {
			return generationBound;
		},
		snapshot: () => ({
			lifecycle,
			replacementListeners: replacementListeners.size,
			lifecycleFailureListeners: lifecycleFailureListeners.size,
			replacementCoordinatorOwned: coordinator !== null,
		}),
		onReplaced(listener) {
			replacementListeners.add(listener);
			return () => replacementListeners.delete(listener);
		},
		onLifecycleFailed(listener) {
			lifecycleFailureListeners.add(listener);
			return () => lifecycleFailureListeners.delete(listener);
		},
		setCoordinator(nextCoordinator) {
			if (coordinator) {
				throw new Error(`Replacement coordinator already set for ${currentRef.sessionId}`);
			}
			coordinator = nextCoordinator;
			return () => {
				if (coordinator === nextCoordinator) coordinator = null;
			};
		},
		setLifecycle(state) {
			lifecycle = state;
		},
		markGenerationInvalidated() {
			if (context) context.invalidated = true;
		},
		async prepareBinding(nextRef) {
			const previousRef = currentRef;
			const activeContext = context;
			if (!activeContext) {
				if (sessionKey(previousRef) !== sessionKey(nextRef)) {
					throw new Error(`Pi runtime attempted to bind session ${nextRef.sessionId} without an active replacement`);
				}
				return null;
			}
			const event = { previousRef, nextRef, reason: activeContext.reason };
			activeContext.candidateRef = nextRef;
			await reserve(activeContext, event);
			let committed = false;
			return {
				async commit() {
					if (committed) return;
					await activeContext.reservation?.commit();
					currentRef = nextRef;
					generationBound = true;
					committed = true;
					for (const listener of replacementListeners) listener(event);
				},
			};
		},
		async replace<Result>(
			reason: SessionRuntimeReplacementReason,
			targetRef: SessionRef | null,
			run: () => Promise<Result>,
			allowOwningPrompt = false,
		): Promise<Result> {
			const resourceReload = host.getActiveResourceReload();
			if (resourceReload) {
				if (allowOwningPrompt) {
					throw sessionReplacementBusy(currentRef);
				}
				return resourceReload.then(
					() => replacement.replace(reason, targetRef, run, allowOwningPrompt),
					() => replacement.replace(reason, targetRef, run, allowOwningPrompt),
				);
			}
			if (lifecycle !== "active") {
				throw sessionLifecycleConflict("replace", lifecycle);
			}
			const counts = host.getOperationCounts();
			const permittedOperations = allowOwningPrompt && counts.activePrompts === 1 ? 1 : 0;
			if (counts.pendingMutations > 0 || counts.active > permittedOperations) {
				throw sessionReplacementBusy(currentRef);
			}

			lifecycle = "replacing";
			generationBound = false;
			const nextContext: ActiveSessionReplacement = {
				reason,
				previousRef: currentRef,
				invalidated: false,
				reservation: null,
				reservedEvent: null,
				candidateRef: targetRef,
			};
			context = nextContext;
			const work = (async () => {
				try {
					if (targetRef) {
						await reserve(nextContext, {
							previousRef: nextContext.previousRef,
							nextRef: targetRef,
							reason,
						});
					}
					const result = await run();
					host.assertRuntimeHealthy();
					return result;
				} catch (error) {
					if (nextContext.invalidated) {
						lifecycle = "disposing";
						try {
							await host.disposeInvalidatedRuntime();
						} catch (disposeError) {
							log.error(`fail-closed disposal failed for session ${currentRef.sessionId}:`, disposeError);
						} finally {
							lifecycle = "disposed";
						}
						emitLifecycleFailure(
							error,
							uniqueSessionRefs([
								nextContext.previousRef,
								...(nextContext.candidateRef ? [nextContext.candidateRef] : []),
								currentRef,
							]),
						);
					}
					throw error;
				}
			})();
			let operation!: Promise<Result>;
			const finishReplacement = async (): Promise<void> => {
				let abortFailure: unknown;
				try {
					await nextContext.reservation?.abort();
				} catch (error) {
					abortFailure = error;
				} finally {
					if (context === nextContext) context = null;
					if (active === operation) active = null;
					if (lifecycle === "replacing") {
						lifecycle = "active";
						generationBound = false;
						try {
							host.emitSnapshotChanged();
						} catch (error) {
							log.error(`replacement snapshot listener failed for session ${currentRef.sessionId}:`, error);
						}
						host.emitDeferredResourceReloadIdleEdge();
					} else {
						generationBound = false;
					}
				}
				if (abortFailure !== undefined) throw toError(abortFailure);
			};
			operation = work.then(
				async (result) => {
					await finishReplacement();
					return result;
				},
				async (workFailure: unknown) => {
					try {
						await finishReplacement();
					} catch (cleanupFailure) {
						throw new AggregateError([workFailure, cleanupFailure], "Pi runtime replacement and cleanup failed");
					}
					throw workFailure;
				},
			);
			active = operation;
			return operation;
		},
		emitLifecycleFailure,
	};
	return replacement;
}
