import type { SessionRef } from "@ling/contracts/session";
import { throwAggregateFailures } from "@ling/core/ling-error";
import type { SessionRuntimeChangeReviewEvent } from "@ling/core/pi-protocol/runtime-types";
import type { PiTurnLifecycle } from "./turn-lifecycle";
import type { PiAgentSession, PiAgentSessionRuntime, PiExtensionBindings } from "../types";
import { PiQueueMirror } from "./queue-mirror";
import { createPiRuntimeTurnTracking, type PiRuntimeTurnTracking } from "./runtime-turn-tracking";

interface RuntimeBoundResourceSnapshot {
	queueMirrorOwned: boolean;
	extensionUiOwned: boolean;
	runtimeServicesOwned: boolean;
}

interface PiRuntimeBoundResources {
	snapshot(): RuntimeBoundResourceSnapshot;
	hasUnsettledRun(): boolean;
	waitForRunSettled(): Promise<void>;
	claimRuntimeServices(runtime: PiAgentSessionRuntime): void;
	bind(ref: SessionRef, runtime: PiAgentSessionRuntime, createBindings: () => PiExtensionBindings): Promise<void>;
	subscribeChangeReview(listener: (event: SessionRuntimeChangeReviewEvent) => void): () => void;
	queueMirror(sessionId: string): PiQueueMirror;
	dispose(releaseServices: boolean): void;
	disposeInstalledRuntime(runtime: PiAgentSessionRuntime): Promise<void>;
}

export function rethrowWithCleanup(operationError: unknown, cleanup: () => void, message: string): never {
	try {
		cleanup();
	} catch (cleanupError) {
		throw new AggregateError([operationError, cleanupError], message);
	}
	throw operationError;
}

export function createPiRuntimeBoundResources(
	initialServices: PiAgentSessionRuntime["services"],
	{
		disposeExtensionUiContext: disposePiExtensionUiContext,
		releaseRuntimeServices: releasePiRuntimeServices,
		turnLifecycle,
		onRunSettled,
	}: {
		disposeExtensionUiContext: (ref: SessionRef) => void;
		releaseRuntimeServices(services: PiAgentSessionRuntime["services"]): void;
		turnLifecycle: PiTurnLifecycle;
		onRunSettled(): void;
	},
): PiRuntimeBoundResources {
	let extensionUiRef: SessionRef | null = null;
	let queueMirror: PiQueueMirror | null = null;
	let unsubscribeRunActivity: (() => void) | null = null;
	let runSettled = Promise.resolve();
	let settleRun: (() => void) | null = null;
	/** Non-null exactly while this handle owns a service lease; that is the whole ownership state. */
	let activeRuntimeServices: PiAgentSessionRuntime["services"] | null = initialServices;
	const turnTracking: PiRuntimeTurnTracking = createPiRuntimeTurnTracking(turnLifecycle);
	const beginRun = (): void => {
		if (settleRun) return;
		const pending = Promise.withResolvers<void>();
		runSettled = pending.promise;
		settleRun = pending.resolve;
	};
	const disposeRunActivity = (): void => {
		unsubscribeRunActivity?.();
		unsubscribeRunActivity = null;
		settleRun?.();
		settleRun = null;
	};

	const disposeExtensionUi = (releaseOwnership = true): void => {
		const ref = extensionUiRef;
		if (!ref) return;
		if (releaseOwnership) extensionUiRef = null;
		disposePiExtensionUiContext(ref);
	};
	const disposeQueueMirror = (): void => {
		const mirror = queueMirror;
		if (!mirror) return;
		queueMirror = null;
		mirror.dispose();
	};
	const dispose = (releaseServices: boolean): void => {
		const failures: unknown[] = [];
		for (const cleanup of [
			() => turnTracking.dispose(),
			disposeQueueMirror,
			() => disposeExtensionUi(),
			disposeRunActivity,
		]) {
			try {
				cleanup();
			} catch (error) {
				failures.push(error);
			}
		}
		const services = activeRuntimeServices;
		if (releaseServices && services) {
			activeRuntimeServices = null;
			try {
				releasePiRuntimeServices(services);
			} catch (error) {
				failures.push(error);
			}
		}
		throwAggregateFailures(failures, "Failed to dispose Pi session runtime resources");
	};
	/**
	 * Takes the lease on an installed generation's service graph. Separate from `bind` because
	 * the graph is live and registered with the project slot the moment Pi installs it, while
	 * binding still has to await a replacement reservation. Anything that fails in between must
	 * find the lease owned, or `dispose` skips it and the graph pins its project open forever.
	 * Idempotent for the generation already claimed.
	 */
	const claimRuntimeServices = (runtime: PiAgentSessionRuntime): void => {
		if (activeRuntimeServices && activeRuntimeServices !== runtime.services) {
			throw new Error(`Previous Pi runtime services are still owned while binding in ${runtime.cwd}`);
		}
		activeRuntimeServices = runtime.services;
	};
	const bind = async (
		ref: SessionRef,
		runtime: PiAgentSessionRuntime,
		createBindings: () => PiExtensionBindings,
	): Promise<void> => {
		if (queueMirror) {
			throw new Error(`Queue mirror is already bound for session ${ref.sessionId}`);
		}
		if (extensionUiRef) {
			throw new Error(`Extension UI context is already bound for session ${extensionUiRef.sessionId}`);
		}
		claimRuntimeServices(runtime);
		const session: PiAgentSession = runtime.session;
		if (unsubscribeRunActivity) throw new Error(`Run activity is already bound for session ${ref.sessionId}`);
		if (!session.isIdle) beginRun();
		const unsubscribe = session.subscribe((event) => {
			if (event.type === "agent_start") beginRun();
			if (event.type !== "agent_settled") return;
			settleRun?.();
			settleRun = null;
			// Pi marks itself idle before awaiting extension settled hooks. Its public
			// event is the drain boundary; let all listeners restore queues before reload.
			queueMicrotask(() => {
				if (unsubscribeRunActivity === unsubscribe) onRunSettled();
			});
		});
		unsubscribeRunActivity = unsubscribe;
		queueMirror = new PiQueueMirror(session);
		turnTracking.bind(runtime.cwd, session, ref);
		extensionUiRef = ref;
		try {
			await session.bindExtensions(createBindings());
		} catch (error) {
			// Clean resources created before the rejected bind immediately, but retain
			// ownership until runtime disposal: session_shutdown handlers may still use
			// the same UI context and create resources that the invalidate hook must reap.
			return rethrowWithCleanup(
				error,
				() => disposeExtensionUi(false),
				"Extension binding and partial UI cleanup both failed",
			);
		}
	};

	return {
		hasUnsettledRun: () => settleRun !== null,
		waitForRunSettled: () => runSettled,
		snapshot: () => ({
			queueMirrorOwned: queueMirror !== null,
			extensionUiOwned: extensionUiRef !== null,
			runtimeServicesOwned: activeRuntimeServices !== null,
		}),
		claimRuntimeServices,
		bind,
		subscribeChangeReview: (listener) => turnTracking.subscribe(listener),
		queueMirror(sessionId) {
			if (!queueMirror) {
				throw new Error(`Queue mirror is not bound for session ${sessionId}`);
			}
			return queueMirror;
		},
		dispose,
		async disposeInstalledRuntime(runtime) {
			const failures: unknown[] = [];
			try {
				await runtime.session.abort();
			} catch (error) {
				failures.push(error);
			}
			await runSettled;
			let runtimeDisposeFailed = false;
			try {
				await runtime.dispose();
			} catch (error) {
				runtimeDisposeFailed = true;
				failures.push(error);
			}
			try {
				// Idempotent after the normal invalidate hook; essential when Pi never
				// reached it because a session_shutdown handler rejected.
				dispose(true);
			} catch (error) {
				failures.push(error);
			}
			if (runtimeDisposeFailed) {
				try {
					runtime.session.dispose();
				} catch (error) {
					failures.push(error);
				}
			}
			throwAggregateFailures(failures, "Failed to dispose Pi session runtime resources");
		},
	};
}
