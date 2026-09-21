import type { SessionRef } from "@ling/contracts/session";
import type { PiMethodParams, PiMethodResult, PiRequestParams } from "@ling/core/pi-protocol/methods";
import type { PiWorkerRuntimeEvent, PiWorkerRuntimeState } from "@ling/core/pi-protocol/protocol";
import type { PiRuntimeMethod } from "@ling/core/pi-protocol/runtime-methods";
import type { RuntimeMethodOptions } from "@ling/core/pi-protocol/method";
import { createPiRuntimeClient, type PiRuntimeCallOptions } from "@ling/core/pi-protocol/runtime-client";
import { piRuntimeMethods } from "@ling/core/pi-protocol/runtime-methods";
import type {
	SessionRuntimeReplacementEvent,
	SessionRuntimeReplacementReservation,
	SessionRuntimeStateSnapshot,
} from "@ling/core/pi-protocol/runtime-types";
import {
	createPiWorkerRuntimeMirror,
	type PiWorkerRuntimeTransport,
	stalePiWorkerRuntimeIdentity,
} from "./pi-worker-runtime-mirror";
import type { SessionRuntimePort } from "@ling/core/pi-protocol/runtime-port";

export interface PiWorkerRemoteRuntime extends SessionRuntimePort {
	readonly runtimeId: string;
	handleHostEvent(event: PiWorkerRuntimeEvent): void;
	handleHostLost(error: Error): void;
	acceptsExtensionUiRef(ref: SessionRef): boolean;
	prepareReplacement(event: SessionRuntimeReplacementEvent): Promise<SessionRuntimeReplacementReservation>;
}

export function createPiWorkerRemoteRuntime(
	runtimeId: string,
	initialState: PiWorkerRuntimeState,
	transport: PiWorkerRuntimeTransport,
	initialEvents: readonly PiWorkerRuntimeEvent[] = [],
): PiWorkerRemoteRuntime {
	const mirror = createPiWorkerRuntimeMirror(runtimeId, initialState, transport, initialEvents);
	let optimisticBusyCount = 0;
	let disposed = false;
	let disposePromise: Promise<void> | null = null;

	const call = async <Method extends PiRuntimeMethod>(
		method: Method,
		args: PiMethodParams<Method>,
		options: PiRuntimeCallOptions = {},
	): Promise<PiMethodResult<Method>> => {
		mirror.assertAvailable();
		if (options.signal?.aborted) {
			throw options.signal.reason ?? new Error(`Pi worker request was cancelled: ${method}`);
		}
		const expectedRef = mirror.getRef();
		const behavior: RuntimeMethodOptions = piRuntimeMethods[method].options;
		const optimisticBusy = behavior.busy === true;
		if (optimisticBusy) optimisticBusyCount += 1;
		try {
			const result = await transport.call(method, { runtimeId, ref: expectedRef, args } as PiRequestParams<Method>, {
				...(behavior.timeoutMs === undefined ? {} : { timeoutMs: behavior.timeoutMs }),
				...(options.signal === undefined ? {} : { signal: options.signal }),
			});
			mirror.assertAvailable();
			if (!behavior.acceptReplacement && !mirror.ownsRef(expectedRef)) {
				throw stalePiWorkerRuntimeIdentity(runtimeId);
			}
			return result;
		} finally {
			if (optimisticBusy) {
				optimisticBusyCount -= 1;
				// Host idle events can arrive before the RPC reply. Deferred reloads
				// need another idle edge after the last optimistic operation settles.
				if (optimisticBusyCount === 0) mirror.notifyIdle();
			}
		}
	};

	const runtime: PiWorkerRemoteRuntime = {
		...createPiRuntimeClient(call),
		runtimeId,
		get ref() {
			return mirror.getRef();
		},
		get cwd() {
			return mirror.getRef().cwd;
		},
		get sessionId() {
			return mirror.getRef().sessionId;
		},
		get sessionFile() {
			return mirror.getState().sessionFile ?? undefined;
		},
		subscribe: mirror.subscribe,
		setReplacementCoordinator: mirror.setReplacementCoordinator,
		onSessionReplaced: mirror.onSessionReplaced,
		onSnapshotChanged: mirror.onSnapshotChanged,
		onTranscriptInvalidated: mirror.onTranscriptInvalidated,
		onTranscriptProjectionChanged: mirror.onTranscriptProjectionChanged,
		onLifecycleFailed: mirror.onLifecycleFailed,
		getSessionName: () => mirror.getState().sessionName ?? undefined,
		async setSessionName(title) {
			const expectedRef = mirror.getRef();
			await call("runtime.setSessionName", { title });
			mirror.setSessionName(expectedRef, title);
		},

		async generateTitle(userMessage) {
			const result = await call("runtime.generateTitle", { userMessage });
			return result ?? undefined;
		},

		summarize(createdAt, placeholderTitle) {
			const state = mirror.getState();
			const storedTitle = state.sessionName?.trim();
			return {
				sessionFilePath: state.summary.sessionFilePath,
				...(state.summary.parentSessionFilePath === undefined
					? {}
					: { parentSessionFilePath: state.summary.parentSessionFilePath }),
				...(state.summary.manualFork === undefined ? {} : { manualFork: state.summary.manualFork }),
				title: storedTitle ? storedTitle : placeholderTitle,
				updatedAt: Math.max(createdAt, state.summary.updatedAt),
				messageCount: state.summary.messageCount,
				preview: state.summary.preview,
				transcriptCacheKey: state.summary.transcriptCacheKey,
			};
		},
		isBusy: () => !mirror.isFailed() && !disposed && (mirror.isHostBusy() || optimisticBusyCount > 0),

		listCommands: () => mirror.getState().commandCatalog,

		releaseExtensionUi() {
			// The Host owns extension contexts and releases the old generation during
			// replacement/disposal. Main only clears its mirrored renderer state here.
		},

		async getStateSnapshot(): Promise<SessionRuntimeStateSnapshot> {
			const state = mirror.getState();
			return {
				...structuredClone(state.snapshot),
				busy: !mirror.isFailed() && !disposed && (mirror.isHostBusy() || optimisticBusyCount > 0),
			};
		},
		getStateSnapshotAtBoundary: mirror.getStateSnapshotAtBoundary,
		getSnapshot: () => mirror.getSnapshotAtBoundary(() => undefined).then(({ snapshot }) => snapshot),
		getSnapshotAtBoundary: mirror.getSnapshotAtBoundary,
		getResourceSnapshot: () => mirror.getState().resources,
		dispose() {
			if (disposePromise) return disposePromise;
			const expectedRef = mirror.getRef();
			disposed = true;
			mirror.markDisposed();
			disposePromise = (
				mirror.isFailed() ? Promise.resolve() : transport.call("runtime.dispose", { runtimeId, ref: expectedRef })
			).finally(() => transport.release(runtimeId));
			return disposePromise;
		},
		handleHostEvent: mirror.handleHostEvent,
		handleHostLost: mirror.handleHostLost,
		acceptsExtensionUiRef: mirror.acceptsExtensionUiRef,
		prepareReplacement: mirror.prepareReplacement,
	};

	return runtime;
}
