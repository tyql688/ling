import type { SessionRef } from "@ling/contracts/session";
import { toSessionRef as cloneRef, sameSessionRef as sameRef, uniqueSessionRefs } from "@ling/contracts/session-ref";
import { toError } from "@ling/core/ling-error";
import type { PiCall, PiMethodResult, PiRequestParams } from "@ling/core/pi-protocol/methods";
import type { PiWorkerRuntimeEvent, PiWorkerRuntimeState } from "@ling/core/pi-protocol/protocol";
import { piWorkerError } from "@ling/core/pi-protocol/protocol-validation";
import { notifyListeners } from "@ling/core/listeners";
import type {
	SessionRuntimeEvent,
	SessionRuntimeReplacementCoordinator,
	SessionRuntimeReplacementEvent,
	SessionRuntimeReplacementReservation,
	SessionRuntimeSnapshot,
	SessionRuntimeStateSnapshot,
} from "@ling/core/pi-protocol/runtime-types";
import type { SessionRuntimePort } from "@ling/core/pi-protocol/runtime-port";

const ATTACH_EVENT_CAPACITY = 1_024;
const SNAPSHOT_EVENT_CAPACITY = 1_024;

export interface PiWorkerRuntimeTransport {
	call: PiCall;
	release(runtimeId: string): void;
	fail(runtimeId: string, error: Error): void;
}

interface PreparedRemoteReplacement {
	event: SessionRuntimeReplacementEvent;
	state: "pending" | "committed" | "aborted";
}

interface SnapshotEventFence {
	events: PiWorkerRuntimeEvent[];
}

interface PiWorkerRuntimeMirror {
	getRef(): SessionRef;
	getState(): PiWorkerRuntimeState;
	isHostBusy(): boolean;
	isFailed(): boolean;
	notifyIdle(): void;
	assertAvailable(): void;
	ownsRef(ref: SessionRef): boolean;
	setSessionName(ref: SessionRef, title: string): boolean;
	subscribe(listener: (event: SessionRuntimeEvent) => void): () => void;
	setReplacementCoordinator(coordinator: SessionRuntimeReplacementCoordinator): () => void;
	onSessionReplaced(listener: (event: SessionRuntimeReplacementEvent) => void): () => void;
	onSnapshotChanged(listener: Parameters<SessionRuntimePort["onSnapshotChanged"]>[0]): () => void;
	onTranscriptInvalidated(listener: Parameters<SessionRuntimePort["onTranscriptInvalidated"]>[0]): () => void;
	onTranscriptProjectionChanged(
		listener: Parameters<SessionRuntimePort["onTranscriptProjectionChanged"]>[0],
	): () => void;
	onLifecycleFailed(listener: Parameters<SessionRuntimePort["onLifecycleFailed"]>[0]): () => void;
	getSnapshotAtBoundary<Boundary>(
		captureBoundary: (snapshot: SessionRuntimeSnapshot) => Boundary,
	): Promise<{ snapshot: SessionRuntimeSnapshot; boundary: Boundary }>;
	getStateSnapshotAtBoundary<Boundary>(
		captureBoundary: (snapshot: SessionRuntimeStateSnapshot) => Boundary,
	): Promise<{ snapshot: SessionRuntimeStateSnapshot; boundary: Boundary }>;
	markDisposed(): void;
	handleHostEvent(event: PiWorkerRuntimeEvent): void;
	handleHostLost(error: Error): void;
	acceptsExtensionUiRef(ref: SessionRef): boolean;
	prepareReplacement(event: SessionRuntimeReplacementEvent): Promise<SessionRuntimeReplacementReservation>;
}

function invalidRuntimeState(runtimeId: string): Error {
	return Object.assign(new Error(`Pi worker runtime is no longer available: ${runtimeId}`), {
		code: "PI_HOST_RUNTIME_UNAVAILABLE" as const,
		retryable: true,
		category: "lifecycle" as const,
		userAction: "retry" as const,
	});
}

export function stalePiWorkerRuntimeIdentity(runtimeId: string): Error {
	return Object.assign(new Error(`Pi worker runtime identity changed during an operation: ${runtimeId}`), {
		code: "STALE_RUNTIME_GENERATION" as const,
		retryable: true,
		category: "lifecycle" as const,
		userAction: "retry" as const,
	});
}

export function createPiWorkerRuntimeMirror(
	runtimeId: string,
	initialState: PiWorkerRuntimeState,
	transport: PiWorkerRuntimeTransport,
	initialEvents: readonly PiWorkerRuntimeEvent[],
): PiWorkerRuntimeMirror {
	if (initialEvents.length > ATTACH_EVENT_CAPACITY) {
		throw new Error(`Pi worker emitted too many events while attaching ${runtimeId}`);
	}
	let state = structuredClone(initialState);
	let ref = cloneRef(state.ref);
	let hostBusy = state.snapshot.busy;
	let lastSequence = 0;
	let failure: { ref: SessionRef; error: Error; relatedRefs: SessionRef[] } | null = null;
	let disposed = false;
	let replacementCoordinator: SessionRuntimeReplacementCoordinator | null = null;
	let preparingReplacement: SessionRuntimeReplacementEvent | null = null;
	let preparedReplacement: PreparedRemoteReplacement | null = null;
	let eventDeliveryStarted = false;
	let eventDeliveryScheduled = false;
	let snapshotEventFence: SnapshotEventFence | null = null;
	let snapshotReadController: AbortController | null = null;
	let snapshotReadTail: Promise<void> = Promise.resolve();
	const attachEvents = [...initialEvents];
	const eventListeners = new Set<(event: SessionRuntimeEvent) => void>();
	const replacementListeners = new Set<(event: SessionRuntimeReplacementEvent) => void>();
	const snapshotChangedListeners = new Set<Parameters<SessionRuntimePort["onSnapshotChanged"]>[0]>();
	const transcriptInvalidatedListeners = new Set<Parameters<SessionRuntimePort["onTranscriptInvalidated"]>[0]>();
	const transcriptProjectionListeners = new Set<Parameters<SessionRuntimePort["onTranscriptProjectionChanged"]>[0]>();
	const lifecycleFailureListeners = new Set<Parameters<SessionRuntimePort["onLifecycleFailed"]>[0]>();
	const notifyIdle = (): void => {
		if (disposed || failure || hostBusy) return;
		notifyListeners(snapshotChangedListeners, "Pi worker idle", cloneRef(ref));
	};

	const assertAvailable = (): void => {
		if (failure) throw failure.error;
		if (disposed) throw invalidRuntimeState(runtimeId);
		if (preparedReplacement?.state === "committed") throw stalePiWorkerRuntimeIdentity(runtimeId);
	};

	const publishFailure = (failedRef: SessionRef, error: Error, relatedRefs: readonly SessionRef[]): void => {
		if (disposed || failure) return;
		failure = {
			ref: cloneRef(failedRef),
			error,
			relatedRefs: uniqueSessionRefs(relatedRefs.map(cloneRef)),
		};
		hostBusy = false;
		transport.release(runtimeId);
		notifyListeners(
			lifecycleFailureListeners,
			"Pi worker lifecycle failure",
			cloneRef(failure.ref),
			error,
			failure.relatedRefs.map(cloneRef),
		);
	};

	const applyState = (next: PiWorkerRuntimeState, expectedRef: SessionRef, label: string): void => {
		if (!sameRef(next.ref, expectedRef)) {
			throw new Error(`${label} carried a mismatched Pi worker runtime identity`);
		}
		if (next.revision <= state.revision) return;
		state = structuredClone(next);
		ref = cloneRef(next.ref);
		hostBusy = next.snapshot.busy;
	};

	const processHostEvent = (event: PiWorkerRuntimeEvent): void => {
		if (event.runtimeId !== runtimeId || event.generation <= 0 || disposed || failure) return;
		if (event.sequence <= lastSequence) return;
		lastSequence = event.sequence;
		switch (event.kind) {
			case "runtimeEvent":
				notifyListeners(eventListeners, "Pi worker runtime event", event.event);
				return;
			case "runtimeState":
				applyState(event.state, ref, "Pi worker state event");
				return;
			case "runtimeBusy": {
				const wasBusy = hostBusy;
				hostBusy = event.busy;
				if (wasBusy && !hostBusy) notifyIdle();
				return;
			}
			case "runtimeReplaced": {
				const prepared = preparedReplacement;
				if (
					prepared?.state !== "committed" ||
					!sameRef(prepared.event.previousRef, event.event.previousRef) ||
					!sameRef(prepared.event.nextRef, event.event.nextRef) ||
					prepared.event.reason !== event.event.reason
				) {
					throw new Error("Pi worker replacement event does not match its Main reservation");
				}
				applyState(event.state, event.event.nextRef, "Pi worker replacement event");
				preparedReplacement = null;
				notifyListeners(replacementListeners, "Pi worker replacement", event.event);
				return;
			}
			case "runtimeSnapshotChanged":
				if (!sameRef(event.ref, ref)) throw new Error("Pi worker snapshot event targets a stale runtime identity");
				applyState(event.state, event.ref, "Pi worker snapshot event");
				notifyListeners(snapshotChangedListeners, "Pi worker snapshot", cloneRef(event.ref));
				return;
			case "runtimeTranscriptInvalidated":
				if (!sameRef(event.ref, ref)) throw new Error("Pi worker transcript event targets a stale runtime identity");
				applyState(event.state, event.ref, "Pi worker transcript event");
				notifyListeners(
					transcriptInvalidatedListeners,
					"Pi worker transcript invalidation",
					cloneRef(event.ref),
					event.reason,
				);
				return;
			case "runtimeTranscriptProjectionChanged":
				if (!sameRef(event.ref, ref)) throw new Error("Pi worker projection event targets a stale runtime identity");
				notifyListeners(
					transcriptProjectionListeners,
					"Pi worker transcript projection",
					cloneRef(event.ref),
					event.reason,
				);
				return;
			case "runtimeLifecycleFailed": {
				const replacementEvent = preparedReplacement?.event ?? preparingReplacement;
				const acceptedFailureRefs = replacementEvent
					? [ref, replacementEvent.previousRef, replacementEvent.nextRef]
					: [ref];
				if (!acceptedFailureRefs.some((candidate) => sameRef(candidate, event.ref))) {
					throw new Error("Pi worker lifecycle failure targets an unrelated runtime identity");
				}
				const error = piWorkerError(event.error);
				const replacementRefs = replacementEvent ? [replacementEvent.previousRef, replacementEvent.nextRef] : [];
				publishFailure(event.ref, error, [...event.relatedRefs, ...replacementRefs]);
				return;
			}
		}
	};

	const acceptHostEvent = (event: PiWorkerRuntimeEvent): void => {
		const fence = snapshotEventFence;
		if (!fence) {
			processHostEvent(event);
			return;
		}
		if (fence.events.length >= SNAPSHOT_EVENT_CAPACITY) {
			throw new Error(`Pi worker emitted too many events while snapshotting ${runtimeId}`);
		}
		fence.events.push(event);
	};

	const scheduleEventDelivery = (): void => {
		if (eventDeliveryStarted || eventDeliveryScheduled) return;
		eventDeliveryScheduled = true;
		queueMicrotask(() => {
			eventDeliveryScheduled = false;
			if (disposed) {
				attachEvents.length = 0;
				return;
			}
			eventDeliveryStarted = true;
			const events = attachEvents.splice(0);
			try {
				for (const event of events) acceptHostEvent(event);
			} catch (error) {
				transport.fail(runtimeId, toError(error));
			}
		});
	};

	const getSnapshotAtBoundaryFor = <Method extends "runtime.getSnapshot" | "runtime.getStateSnapshot", Boundary>(
		method: Method,
		captureBoundary: (snapshot: PiMethodResult<Method>["snapshot"]) => Boundary,
	): Promise<{ snapshot: PiMethodResult<Method>["snapshot"]; boundary: Boundary }> => {
		assertAvailable();
		const {
			promise: result,
			resolve: resolveResult,
			reject: rejectResult,
		} = Promise.withResolvers<{ snapshot: PiMethodResult<Method>["snapshot"]; boundary: Boundary }>();
		const turn = snapshotReadTail.then(
			() =>
				new Promise<void>((finishTurn) => {
					try {
						assertAvailable();
					} catch (error) {
						rejectResult(error);
						finishTurn();
						return;
					}
					const fence: SnapshotEventFence = { events: [] };
					const controller = new AbortController();
					snapshotEventFence = fence;
					snapshotReadController = controller;
					const release = (processBufferedEvents: boolean): void => {
						if (snapshotEventFence === fence) snapshotEventFence = null;
						if (snapshotReadController === controller) snapshotReadController = null;
						const events = fence.events.splice(0);
						if (processBufferedEvents && !disposed) {
							try {
								for (const event of events) processHostEvent(event);
							} catch (error) {
								transport.fail(runtimeId, toError(error));
							}
						}
						finishTurn();
					};
					const expectedRef = cloneRef(ref);
					void transport
						.call(method, { runtimeId, ref: expectedRef } as PiRequestParams<Method>, { signal: controller.signal })
						.then(
							(snapshotResult) => {
								if (disposed) {
									rejectResult(invalidRuntimeState(runtimeId));
									queueMicrotask(() => release(false));
									return;
								}
								if (!sameRef(snapshotResult.ref, expectedRef) || !sameRef(ref, expectedRef)) {
									rejectResult(stalePiWorkerRuntimeIdentity(runtimeId));
									queueMicrotask(() => release(true));
									return;
								}
								const afterBoundary: PiWorkerRuntimeEvent[] = [];
								try {
									for (const event of fence.events.splice(0)) {
										if (event.sequence <= snapshotResult.eventSequence) processHostEvent(event);
										else afterBoundary.push(event);
									}
									fence.events.push(...afterBoundary);
									if (lastSequence !== snapshotResult.eventSequence) {
										throw new Error(
											`Pi worker snapshot event boundary mismatch: expected ${snapshotResult.eventSequence}, received ${lastSequence}`,
										);
									}
								} catch (error) {
									const protocolError = toError(error);
									rejectResult(protocolError);
									transport.fail(runtimeId, protocolError);
									queueMicrotask(() => release(false));
									return;
								}
								try {
									resolveResult({
										snapshot: snapshotResult.snapshot,
										boundary: captureBoundary(snapshotResult.snapshot),
									});
								} catch (error) {
									rejectResult(error);
								}
								queueMicrotask(() => release(true));
							},
							(error: unknown) => {
								rejectResult(disposed ? invalidRuntimeState(runtimeId) : error);
								queueMicrotask(() => release(!disposed));
							},
						);
				}),
			(error: unknown) => {
				rejectResult(error);
			},
		);
		snapshotReadTail = turn.catch(() => undefined);
		return result;
	};
	const getSnapshotAtBoundary = <Boundary>(captureBoundary: (snapshot: SessionRuntimeSnapshot) => Boundary) =>
		getSnapshotAtBoundaryFor<"runtime.getSnapshot", Boundary>("runtime.getSnapshot", captureBoundary);
	const getStateSnapshotAtBoundary = <Boundary>(captureBoundary: (snapshot: SessionRuntimeStateSnapshot) => Boundary) =>
		getSnapshotAtBoundaryFor<"runtime.getStateSnapshot", Boundary>("runtime.getStateSnapshot", captureBoundary);

	return {
		getRef: () => cloneRef(ref),
		getState: () => state,
		isHostBusy: () => hostBusy,
		isFailed: () => failure !== null,
		notifyIdle,
		assertAvailable,
		ownsRef: (candidate) => sameRef(ref, candidate),
		setSessionName(expectedRef, title) {
			if (!sameRef(ref, expectedRef)) return false;
			state = {
				...state,
				sessionName: title,
				summary: { ...state.summary, storedTitle: title },
			};
			return true;
		},
		subscribe(listener) {
			eventListeners.add(listener);
			scheduleEventDelivery();
			return () => eventListeners.delete(listener);
		},
		setReplacementCoordinator(coordinator) {
			if (replacementCoordinator !== null) throw new Error(`Replacement coordinator already set for ${runtimeId}`);
			replacementCoordinator = coordinator;
			return () => {
				if (replacementCoordinator === coordinator) replacementCoordinator = null;
			};
		},
		onSessionReplaced(listener) {
			replacementListeners.add(listener);
			return () => replacementListeners.delete(listener);
		},
		onSnapshotChanged(listener) {
			snapshotChangedListeners.add(listener);
			return () => snapshotChangedListeners.delete(listener);
		},
		onTranscriptInvalidated(listener) {
			transcriptInvalidatedListeners.add(listener);
			return () => transcriptInvalidatedListeners.delete(listener);
		},
		onTranscriptProjectionChanged(listener) {
			transcriptProjectionListeners.add(listener);
			return () => transcriptProjectionListeners.delete(listener);
		},
		onLifecycleFailed(listener) {
			lifecycleFailureListeners.add(listener);
			const currentFailure = failure;
			if (currentFailure) {
				queueMicrotask(() => {
					if (!lifecycleFailureListeners.has(listener)) return;
					notifyListeners(
						[listener],
						"Pi worker lifecycle failure",
						cloneRef(currentFailure.ref),
						currentFailure.error,
						currentFailure.relatedRefs.map(cloneRef),
					);
				});
			}
			return () => lifecycleFailureListeners.delete(listener);
		},
		getSnapshotAtBoundary,
		getStateSnapshotAtBoundary,
		markDisposed() {
			disposed = true;
			attachEvents.length = 0;
			snapshotReadController?.abort(invalidRuntimeState(runtimeId));
		},
		handleHostEvent(event) {
			if (!eventDeliveryStarted) {
				if (attachEvents.length >= ATTACH_EVENT_CAPACITY) {
					throw new Error(`Pi worker emitted too many events while attaching ${runtimeId}`);
				}
				attachEvents.push(event);
				return;
			}
			acceptHostEvent(event);
		},
		handleHostLost(error) {
			const replacementEvent = preparedReplacement?.event ?? preparingReplacement;
			const replacementRefs = replacementEvent ? [replacementEvent.previousRef, replacementEvent.nextRef] : [];
			publishFailure(ref, error, [ref, ...replacementRefs]);
		},
		acceptsExtensionUiRef(candidate) {
			if (disposed || failure) return false;
			if (sameRef(candidate, ref)) return true;
			const replacementEvent = preparedReplacement?.event ?? preparingReplacement;
			return replacementEvent !== null && sameRef(candidate, replacementEvent.nextRef);
		},
		async prepareReplacement(event) {
			assertAvailable();
			if (!sameRef(event.previousRef, ref)) {
				throw new Error("Pi worker replacement targets a stale runtime identity");
			}
			if (replacementCoordinator === null) {
				throw new Error("Pi worker replacement coordinator is not registered");
			}
			if (preparingReplacement !== null || preparedReplacement !== null) {
				throw new Error("Pi worker replacement reservation is already active");
			}
			const stagedEvent = {
				previousRef: cloneRef(event.previousRef),
				nextRef: cloneRef(event.nextRef),
				reason: event.reason,
			};
			preparingReplacement = stagedEvent;
			try {
				const reservation = await replacementCoordinator(event);
				if (failure) {
					try {
						await reservation.abort();
					} catch (cleanupError) {
						throw new AggregateError(
							[failure.error, cleanupError],
							"Failed to release a Pi worker replacement after host loss",
						);
					}
					throw failure.error;
				}
				const prepared: PreparedRemoteReplacement = { event: stagedEvent, state: "pending" };
				preparedReplacement = prepared;
				return {
					async commit() {
						if (prepared.state !== "pending") return;
						await reservation.commit();
						// Session ownership is now reserved under nextRef, but old Host
						// events remain valid until runtimeReplaced establishes the event boundary.
						prepared.state = "committed";
					},
					async abort() {
						if (prepared.state !== "pending") return;
						try {
							await reservation.abort();
						} finally {
							prepared.state = "aborted";
							if (preparedReplacement === prepared) preparedReplacement = null;
						}
					},
				};
			} finally {
				if (preparingReplacement === stagedEvent) preparingReplacement = null;
			}
		},
	};
}
