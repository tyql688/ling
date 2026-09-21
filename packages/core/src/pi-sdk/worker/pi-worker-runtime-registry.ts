import type { PiExtensionUi } from "../extensions/extension-ui-context";
import { sessionKey } from "@ling/contracts/session-ref";
import { throwAggregateFailures, toError } from "@ling/core/ling-error";
import { createPiWorkerReplacementReservation } from "@ling/core/pi-protocol/replacement-reservation";
import type { PiSessionRuntimeHandle } from "../session/runtime";
import type { PiWorkerEvent, PiWorkerRuntimeBootstrap } from "../../pi-protocol/protocol";
import { PI_WORKER_PROTOCOL_VERSION } from "../../pi-protocol/wire-format";
import { parsePiWorkerRuntimeId, piWorkerErrorDto } from "../../pi-protocol/protocol-validation";
import type { PiWorkerDialogBridge, PiWorkerDialogContext } from "./pi-worker-dialog-bridge";
import type { PiWorkerCallMain } from "@ling/core/pi-protocol/callback-methods";
import {
	createPiWorkerRuntimeEventDelivery,
	type PiWorkerEventPayload,
	type PiWorkerRuntimeEventDelivery,
} from "./pi-worker-runtime-events";
import { createPiWorkerRuntimeStateBuilder } from "./pi-worker-runtime-state";

interface PiWorkerRuntimeRecord {
	runtimeId: string;
	runtime: PiSessionRuntimeHandle;
	rollbackSessionFile: string | null;
	dialogs: PiWorkerDialogContext;
	buildState: ReturnType<typeof createPiWorkerRuntimeStateBuilder>;
	delivery: PiWorkerRuntimeEventDelivery;
	disposed: boolean;
	unsubscribers: (() => void)[];
	unsubscribeRuntimeEvents: () => void;
}

interface PiWorkerRuntimeRegistryOptions {
	extensionUi: PiExtensionUi;
	generation: number;
	callMain: PiWorkerCallMain;
	emit(event: PiWorkerEvent): void;
	onFatal(error: Error): void;
	dialogBridge: PiWorkerDialogBridge;
}

interface PiWorkerRuntimeRegistry {
	assertAccepting(): void;
	attach(
		runtimeId: string,
		runtime: PiSessionRuntimeHandle,
		dialogs: PiWorkerDialogContext,
		rollbackSessionFile: string | null,
	): Promise<PiWorkerRuntimeBootstrap>;
	get(runtimeId: string): PiWorkerRuntimeRecord | undefined;
	require(runtimeId: string): PiWorkerRuntimeRecord;
	disposeRuntime(record: PiWorkerRuntimeRecord): Promise<void>;
	disposeProjectRuntimes(cwd: string): Promise<void>;
	refreshSettings(): Promise<void>;
	dispose(): Promise<void>;
}

export function createPiWorkerRuntimeRegistry(options: PiWorkerRuntimeRegistryOptions): PiWorkerRuntimeRegistry {
	const { onExtensionUiStateChanged } = options.extensionUi.bridge;
	const { rerenderPiExtensionComponents } = options.extensionUi.components;
	const { disposePiExtensionUiViewport, rerenderPiExtensionCustomPanel } = options.extensionUi.customPanels;

	const runtimes = new Map<string, PiWorkerRuntimeRecord>();
	let disposed = false;
	let extensionSequence = 0;

	const emit = (event: PiWorkerEventPayload): void => {
		try {
			options.emit({
				...event,
				protocolVersion: PI_WORKER_PROTOCOL_VERSION,
				generation: options.generation,
			});
		} catch (error) {
			const fatalError = toError(error);
			options.onFatal(fatalError);
			throw fatalError;
		}
	};

	const releaseExtensionUi = onExtensionUiStateChanged((ref, _snapshot, event) => {
		const runtimeId = options.dialogBridge.runtimeIdFor(ref);
		if (runtimeId === null) return;
		extensionSequence += 1;
		emit({ kind: "extensionUiState", runtimeId, sequence: extensionSequence, ref, event });
	});

	const assertAccepting = (): void => {
		if (disposed) throw new Error("Pi worker runtime service is shutting down");
	};

	const bindRuntimeEventSubscription = (record: PiWorkerRuntimeRecord): void => {
		record.delivery.flushMessageUpdate();
		record.unsubscribeRuntimeEvents();
		record.unsubscribeRuntimeEvents = record.runtime.subscribe(record.delivery.deliver);
	};

	const requireRuntime = (runtimeId: string): PiWorkerRuntimeRecord => {
		const record = runtimes.get(runtimeId);
		if (!record || record.disposed) throw new Error(`Pi runtime is not available: ${runtimeId}`);
		return record;
	};

	const disposeRuntime = async (record: PiWorkerRuntimeRecord): Promise<void> => {
		if (record.disposed) return;
		record.delivery.flushMessageUpdate();
		record.disposed = true;
		runtimes.delete(record.runtimeId);
		const failures: unknown[] = [];
		try {
			record.unsubscribeRuntimeEvents();
		} catch (error) {
			failures.push(error);
		}
		for (const unsubscribe of record.unsubscribers.reverse()) {
			try {
				unsubscribe();
			} catch (error) {
				failures.push(error);
			}
		}
		try {
			await record.delivery.waitForDelivery();
		} catch (error) {
			failures.push(error);
		}
		try {
			await record.runtime.dispose();
		} catch (error) {
			failures.push(error);
		}
		try {
			options.dialogBridge.releaseAll(record.dialogs);
		} catch (error) {
			failures.push(error);
		}
		throwAggregateFailures(failures, `Failed to dispose Pi runtime ${record.runtimeId}`);
	};

	const attach = async (
		runtimeId: string,
		runtime: PiSessionRuntimeHandle,
		dialogs: PiWorkerDialogContext,
		rollbackSessionFile: string | null,
	): Promise<PiWorkerRuntimeBootstrap> => {
		assertAccepting();
		if (runtimes.has(runtimeId)) throw new Error(`Pi worker runtime id is already active: ${runtimeId}`);
		let record!: PiWorkerRuntimeRecord;
		const delivery = createPiWorkerRuntimeEventDelivery({
			runtimeId,
			runtime,
			buildState: () => record.buildState(),
			emit,
			isDisposed: () => record.disposed,
			onFatal: options.onFatal,
			onTranscriptAdvanced: () => {
				if (record.disposed) return;
				rerenderPiExtensionComponents(runtime.ref);
				rerenderPiExtensionCustomPanel(runtime.ref);
			},
		});
		record = {
			runtimeId,
			runtime,
			rollbackSessionFile,
			dialogs,
			buildState: createPiWorkerRuntimeStateBuilder(runtime),
			delivery,
			disposed: false,
			unsubscribers: [],
			unsubscribeRuntimeEvents: () => undefined,
		};
		const enqueueRuntimeEvent = (build: () => PiWorkerEventPayload): void => {
			record.delivery.enqueue(() => {
				if (!record.disposed) emit(build());
			});
		};
		const enqueueRuntimeStateEvent = (
			build: (state: PiWorkerRuntimeBootstrap["state"]) => PiWorkerEventPayload,
		): void => {
			record.delivery.enqueue(async () => {
				if (record.disposed) return;
				const state = await record.buildState();
				if (!record.disposed) emit(build(state));
			});
		};
		runtimes.set(runtimeId, record);
		try {
			record.unsubscribers.push(
				runtime.setReplacementCoordinator(async (event) => {
					options.dialogBridge.bind(dialogs, event.nextRef);
					let reservationId: string;
					try {
						const result = await options.callMain("runtime.prepareReplacement", {
							runtimeId,
							event,
						});
						reservationId = parsePiWorkerRuntimeId(result.reservationId);
					} catch (error) {
						options.dialogBridge.release(dialogs, event.nextRef);
						throw error;
					}
					return createPiWorkerReplacementReservation(options.generation, runtimeId, {
						async commit() {
							// Reduce the old-event tail before asking Main to commit ownership.
							// Main's mirror still retains previousRef until runtimeReplaced, so
							// an event queued during this await remains correctly attributed.
							await record.delivery.waitForDelivery();
							await options.callMain("runtime.commitReplacement", { reservationId });
							if (sessionKey(event.previousRef) !== sessionKey(event.nextRef)) {
								options.dialogBridge.release(dialogs, event.previousRef);
								// The runtime handle only ever clears the viewport for its current ref,
								// so a replaced identity is released here or never.
								disposePiExtensionUiViewport(event.previousRef);
							}
						},
						async abort() {
							try {
								await options.callMain("runtime.abortReplacement", { reservationId });
							} finally {
								if (sessionKey(event.previousRef) !== sessionKey(event.nextRef)) {
									options.dialogBridge.release(dialogs, event.nextRef);
								}
							}
						},
					});
				}),
			);
			bindRuntimeEventSubscription(record);
			record.unsubscribers.push(
				runtime.onSessionReplaced((event) => {
					bindRuntimeEventSubscription(record);
					enqueueRuntimeStateEvent((state) => ({
						kind: "runtimeReplaced",
						runtimeId,
						sequence: record.delivery.nextSequence(),
						event,
						state,
					}));
				}),
				runtime.onSnapshotChanged((ref) => {
					record.delivery.flushMessageUpdate();
					enqueueRuntimeStateEvent((state) => ({
						kind: "runtimeSnapshotChanged",
						runtimeId,
						sequence: record.delivery.nextSequence(),
						ref,
						state,
					}));
				}),
				runtime.onTranscriptInvalidated((ref, reason) => {
					if (reason === "reload") bindRuntimeEventSubscription(record);
					else record.delivery.flushMessageUpdate();
					enqueueRuntimeStateEvent((state) => ({
						kind: "runtimeTranscriptInvalidated",
						runtimeId,
						sequence: record.delivery.nextSequence(),
						ref,
						reason,
						state,
					}));
				}),
				runtime.onTranscriptProjectionChanged((ref, reason) => {
					record.delivery.flushMessageUpdate();
					enqueueRuntimeEvent(() => ({
						kind: "runtimeTranscriptProjectionChanged",
						runtimeId,
						sequence: record.delivery.nextSequence(),
						ref,
						reason,
					}));
				}),
				runtime.onLifecycleFailed((ref, error, relatedRefs) => {
					record.delivery.flushMessageUpdate();
					enqueueRuntimeEvent(() => ({
						kind: "runtimeLifecycleFailed",
						runtimeId,
						sequence: record.delivery.nextSequence(),
						ref,
						error: piWorkerErrorDto(error, "PI_RUNTIME_LIFECYCLE_FAILED"),
						relatedRefs: [...relatedRefs],
					}));
					void record.delivery
						.waitForDelivery()
						.then(() => disposeRuntime(record))
						.catch((cleanupError: unknown) => {
							options.onFatal(toError(cleanupError));
						});
				}),
			);
			return { runtimeId, state: await record.buildState() };
		} catch (error) {
			record.disposed = true;
			runtimes.delete(runtimeId);
			record.delivery.discardPendingMessageUpdate();
			const failures: unknown[] = [error];
			for (const unsubscribe of record.unsubscribers.reverse()) {
				try {
					unsubscribe();
				} catch (cleanupError) {
					failures.push(cleanupError);
				}
			}
			try {
				record.unsubscribeRuntimeEvents();
			} catch (cleanupError) {
				failures.push(cleanupError);
			}
			try {
				options.dialogBridge.releaseAll(dialogs);
			} catch (cleanupError) {
				failures.push(cleanupError);
			}
			try {
				await runtime.dispose();
			} catch (cleanupError) {
				failures.push(cleanupError);
			}
			throwAggregateFailures(failures, `Failed to attach Pi runtime ${runtimeId}`);
			throw new Error("Unreachable Pi runtime attachment cleanup");
		}
	};

	return {
		assertAccepting,
		attach,
		get: (runtimeId) => runtimes.get(runtimeId),
		require: requireRuntime,
		disposeRuntime,
		async refreshSettings() {
			assertAccepting();
			const results = await Promise.allSettled(
				[...runtimes.values()].map((record) => record.runtime.refreshSettings()),
			);
			throwAggregateFailures(
				results.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
				"Failed to refresh live Pi settings",
			);
		},
		async disposeProjectRuntimes(cwd) {
			const targets = [...runtimes.values()].filter((record) => record.runtime.cwd === cwd);
			const results = await Promise.allSettled(targets.map(disposeRuntime));
			throwAggregateFailures(
				results.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
				`Failed to dispose Pi runtimes for ${cwd}`,
			);
		},
		async dispose() {
			if (disposed) return;
			disposed = true;
			releaseExtensionUi();
			const results = await Promise.allSettled([...runtimes.values()].map(disposeRuntime));
			throwAggregateFailures(
				results.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
				"Failed to dispose the Pi worker runtime service",
			);
		},
	};
}
