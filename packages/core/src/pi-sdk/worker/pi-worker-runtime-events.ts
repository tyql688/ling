import { toError } from "@ling/core/ling-error";
import { createSessionMessageDelta } from "@ling/contracts/session-message-delta";
import type { AssistantSessionMessage } from "@ling/contracts/session-messages";
import type { SessionRuntimeEvent } from "@ling/core/pi-protocol/runtime-types";
import type { SessionRuntimePort } from "@ling/core/pi-protocol/runtime-port";
import type { PiWorkerEvent, PiWorkerRuntimeState } from "../../pi-protocol/protocol";

const MESSAGE_UPDATE_FLUSH_INTERVAL_MS = 16;
const EVENT_DELIVERY_CAPACITY = 1_024;

export type PiWorkerEventPayload = PiWorkerEvent extends infer Event
	? Event extends unknown
		? Omit<Event, "protocolVersion" | "generation">
		: never
	: never;

export interface PiWorkerRuntimeEventDelivery {
	deliver(event: SessionRuntimeEvent): void;
	enqueue(work: () => Promise<void> | void): void;
	capture<Result>(work: () => Promise<Result>): Promise<{ result: Result; eventSequence: number }>;
	flushMessageUpdate(): void;
	nextSequence(): number;
	waitForDelivery(): Promise<void>;
	discardPendingMessageUpdate(): void;
}

interface PiWorkerRuntimeEventDeliveryOptions {
	runtimeId: string;
	runtime: Pick<SessionRuntimePort, "isBusy">;
	buildState(): Promise<PiWorkerRuntimeState>;
	emit(event: PiWorkerEventPayload): void;
	isDisposed(): boolean;
	onFatal(error: Error): void;
	/** Fired after a messageEnd runtime event is emitted. Pi's TUI redraws component
	 * surfaces on every app activity, so extension widgets/panels that derive from session
	 * state (entries, tool results) update implicitly there; the offscreen adapter has no
	 * redraw loop and must re-render them at the transcript boundary instead. */
	onTranscriptAdvanced?(): void;
}

export function createPiWorkerRuntimeEventDelivery(
	options: PiWorkerRuntimeEventDeliveryOptions,
): PiWorkerRuntimeEventDelivery {
	let sequence = 0;
	let deliveryTail = Promise.resolve();
	let queuedDeliveries = 0;
	let pendingMessageUpdate: Extract<SessionRuntimeEvent, { type: "messageUpdate" }> | null = null;
	let messageUpdateTimer: ReturnType<typeof setTimeout> | null = null;
	let lastEmittedBusy: boolean | null = null;
	// Retain only the currently streaming assistant; every boundary drops the baseline.
	let messageBaseline: AssistantSessionMessage | null = null;

	const nextSequence = (): number => {
		sequence += 1;
		return sequence;
	};

	const enqueue = (work: () => Promise<void> | void): void => {
		if (queuedDeliveries >= EVENT_DELIVERY_CAPACITY) {
			const error = new Error(`Pi worker event delivery capacity is full for ${options.runtimeId}`);
			options.onFatal(error);
			throw error;
		}
		queuedDeliveries += 1;
		deliveryTail = deliveryTail
			.then(work)
			.catch((error: unknown) => {
				console.error(`[pi-worker] event delivery failed for ${options.runtimeId}:`, error);
				options.onFatal(toError(error));
			})
			.finally(() => {
				queuedDeliveries -= 1;
			});
	};

	const emitBusyIfChanged = (): void => {
		if (options.isDisposed()) return;
		const busy = options.runtime.isBusy();
		if (busy === lastEmittedBusy) return;
		lastEmittedBusy = busy;
		options.emit({
			kind: "runtimeBusy",
			runtimeId: options.runtimeId,
			sequence: nextSequence(),
			busy,
		});
	};

	const emitRuntimeEvent = async (event: SessionRuntimeEvent): Promise<void> => {
		if (options.isDisposed()) return;
		let outgoing = event;
		if (event.type === "messageUpdate" && event.message.role === "assistant") {
			if (messageBaseline && event.streamMode !== "full")
				outgoing = createSessionMessageDelta(messageBaseline, event.message) ?? event;
			messageBaseline = event.message;
		} else if (event.type === "messageStart" && event.message.role === "assistant") {
			messageBaseline = event.message;
		} else if (
			event.type === "messageEnd" ||
			event.type === "runFinished" ||
			event.type === "snapshotChanged" ||
			event.type === "transcriptInvalidated" ||
			event.type === "transcriptProjectionChanged"
		) {
			messageBaseline = null;
		}
		if (event.type === "runFinished" || event.type === "snapshotChanged") {
			const state = await options.buildState();
			if (options.isDisposed()) return;
			options.emit({
				kind: "runtimeState",
				runtimeId: options.runtimeId,
				sequence: nextSequence(),
				state,
			});
		}
		if (options.isDisposed()) return;
		options.emit({
			kind: "runtimeEvent",
			runtimeId: options.runtimeId,
			sequence: nextSequence(),
			event: outgoing,
		});
		if (event.type === "messageEnd") {
			// After the transcript event lands, extension component surfaces re-render against
			// the advanced session state. Render failures are contained per component inside
			// the rerender helpers; a throw here must not reach the delivery's fatal path.
			try {
				options.onTranscriptAdvanced?.();
			} catch (error) {
				console.error(`[pi-worker] extension surface rerender failed for ${options.runtimeId}:`, error);
			}
		}
		emitBusyIfChanged();
	};

	const queuePendingMessageUpdate = (): void => {
		if (messageUpdateTimer) clearTimeout(messageUpdateTimer);
		messageUpdateTimer = null;
		const latest = pendingMessageUpdate;
		pendingMessageUpdate = null;
		if (latest) enqueue(() => emitRuntimeEvent(latest));
	};

	const flushMessageUpdate = (): void => {
		queuePendingMessageUpdate();
	};

	const deliver = (event: SessionRuntimeEvent): void => {
		if (options.isDisposed()) return;
		if (event.type !== "messageUpdate") {
			flushMessageUpdate();
			enqueue(() => emitRuntimeEvent(event));
			return;
		}
		if (pendingMessageUpdate && pendingMessageUpdate.message.id !== event.message.id) flushMessageUpdate();
		pendingMessageUpdate = event;
		if (messageUpdateTimer) return;
		messageUpdateTimer = setTimeout(() => {
			if (!options.isDisposed()) queuePendingMessageUpdate();
		}, MESSAGE_UPDATE_FLUSH_INTERVAL_MS);
	};

	return {
		deliver,
		enqueue,
		capture<Result>(work: () => Promise<Result>) {
			flushMessageUpdate();
			return new Promise<{ result: Result; eventSequence: number }>((resolve, reject) => {
				enqueue(async () => {
					try {
						emitBusyIfChanged();
						const result = await work();
						// The snapshot is a full alignment point; the next live update must establish a fresh baseline.
						messageBaseline = null;
						resolve({ result, eventSequence: sequence });
					} catch (error) {
						reject(error);
					}
				});
			});
		},
		flushMessageUpdate,
		nextSequence,
		waitForDelivery() {
			flushMessageUpdate();
			if (!options.isDisposed()) enqueue(emitBusyIfChanged);
			return deliveryTail;
		},
		discardPendingMessageUpdate() {
			if (messageUpdateTimer) clearTimeout(messageUpdateTimer);
			messageUpdateTimer = null;
			pendingMessageUpdate = null;
			messageBaseline = null;
		},
	};
}
