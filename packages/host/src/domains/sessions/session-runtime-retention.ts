import { uniqueSessionRefs, sessionKey } from "@ling/contracts/session-ref";
import type { ManagedSessionManager } from "@ling/host/domains/sessions/manager/session-manager";
import type { SessionRef } from "@ling/contracts/session";
import { createLogger } from "@ling/core/logger";

const log = createLogger("session-runtime-retention");

interface SessionRuntimeRetentionOptions {
	manager: ManagedSessionManager;
	pendingInteractionRefs(): readonly SessionRef[];
	onSuspending(ref: SessionRef, retentionRevision: number): void;
	onSuspended(ref: SessionRef, retentionRevision: number): void;
}

interface SessionRuntimeRetentionHost {
	/** A selected/new runtime stays live and cancels any archive-triggered suspension request. */
	retain(ref: SessionRef): number;
	/** Archive-triggered suspension persists until the runtime becomes truly idle. */
	suspendWhenIdle(ref: SessionRef): void;
	/** Re-check after a run, queue, approval, or extension interaction settles. */
	reap(): void;
	forget(refs: readonly SessionRef[]): void;
	/** Final fail-closed release revisions are forwarded to renderer eviction. */
	retire(refs: readonly SessionRef[]): Array<{ ref: SessionRef; retentionRevision: number }>;
	prepareShutdown(): void;
	dispose(): Promise<void>;
}

/** Serializes runtime retirement so concurrent resume/archive/run-finish paths cannot dispose the
 * same session twice. Core performs the final idle check; main protects host-owned dialogs. */
export function createSessionRuntimeRetentionHost(
	options: SessionRuntimeRetentionOptions,
): SessionRuntimeRetentionHost {
	const { suspendSessionIfIdle } = options.manager;
	const { findManagedSession, listIdleManagedSessionEvictionCandidates } = options.manager.registry;

	const requestedSuspensions = new Map<string, { ref: SessionRef; retentionRevision: number }>();
	const retentionRevisions = new Map<string, number>();
	const retainedRefs = new Map<string, { ref: SessionRef; retentionRevision: number }>();
	let nextRetentionRevision = 0;
	let activeSweep: Promise<void> | null = null;
	let sweepRequested = false;
	let disposed = false;
	let disposal: Promise<void> | null = null;
	const prepareShutdown = (): void => {
		disposed = true;
		sweepRequested = false;
		requestedSuspensions.clear();
		retainedRefs.clear();
		retentionRevisions.clear();
	};

	const advanceRetentionRevision = (ref: SessionRef): number => {
		nextRetentionRevision += 1;
		retentionRevisions.set(sessionKey(ref), nextRetentionRevision);
		return nextRetentionRevision;
	};
	const currentRetentionRevision = (ref: SessionRef): number => {
		const current = retentionRevisions.get(sessionKey(ref));
		return current ?? advanceRetentionRevision(ref);
	};
	const latestRetainedRef = (): SessionRef | null => {
		let latest: { ref: SessionRef; retentionRevision: number } | null = null;
		for (const retained of retainedRefs.values()) {
			if (!latest || retained.retentionRevision > latest.retentionRevision) latest = retained;
		}
		return latest?.ref ?? null;
	};

	const sweep = async (): Promise<void> => {
		while (true) {
			if (disposed) return;
			const interactionRefs = options.pendingInteractionRefs();
			const latestRef = latestRetainedRef();
			const protectedRefs = latestRef ? [...interactionRefs, latestRef] : interactionRefs;
			const interactionKeys = new Set(interactionRefs.map(sessionKey));
			for (const [key, request] of requestedSuspensions) {
				if (findManagedSession(request.ref)) continue;
				requestedSuspensions.delete(key);
				if (retentionRevisions.get(key) === request.retentionRevision) retentionRevisions.delete(key);
			}

			const candidates = new Map<string, { ref: SessionRef; retentionRevision: number }>();
			for (const [key, request] of requestedSuspensions) {
				if (!interactionKeys.has(key)) candidates.set(key, request);
			}
			for (const ref of listIdleManagedSessionEvictionCandidates(protectedRefs)) {
				candidates.set(sessionKey(ref), { ref, retentionRevision: currentRetentionRevision(ref) });
			}
			if (candidates.size === 0) return;

			let madeProgress = false;
			for (const candidate of candidates.values()) {
				if (disposed) return;
				const { ref, retentionRevision } = candidate;
				let retired = false;
				try {
					const suspended = await suspendSessionIfIdle(
						ref,
						(currentRef) => {
							if (disposed) return false;
							const currentKey = sessionKey(currentRef);
							if (retentionRevisions.get(currentKey) !== retentionRevision) return false;
							if (options.pendingInteractionRefs().some((pendingRef) => sessionKey(pendingRef) === currentKey)) {
								return false;
							}
							options.onSuspending(currentRef, retentionRevision);
							return true;
						},
						(currentRef) => {
							if (!disposed) options.onSuspended(currentRef, retentionRevision);
						},
					);
					if (!suspended) continue;
					retired = true;
				} catch (error) {
					log.error(`failed to suspend idle session ${ref.sessionId}:`, error);
				} finally {
					const key = sessionKey(ref);
					if (!findManagedSession(ref)) {
						const request = requestedSuspensions.get(key);
						if (request?.retentionRevision === retentionRevision) requestedSuspensions.delete(key);
						const retained = retainedRefs.get(key);
						if (retained?.retentionRevision === retentionRevision) retainedRefs.delete(key);
						if (retentionRevisions.get(key) === retentionRevision) retentionRevisions.delete(key);
						retired = true;
					}
					if (retired) madeProgress = true;
				}
			}
			if (!madeProgress) return;
		}
	};

	const queueSweep = (): Promise<void> => {
		if (disposed) return Promise.resolve();
		sweepRequested = true;
		if (activeSweep) return activeSweep;
		const running = (async () => {
			while (sweepRequested) {
				sweepRequested = false;
				try {
					await sweep();
				} catch (error) {
					log.error("runtime-retention sweep failed:", error);
				}
			}
		})();
		const tracked: Promise<void> = running.finally(() => {
			if (activeSweep === tracked) activeSweep = null;
			if (sweepRequested) void queueSweep();
		});
		activeSweep = tracked;
		return tracked;
	};

	return {
		retain(ref) {
			if (disposed) throw new Error("Session runtime retention is shutting down");
			const retentionRevision = advanceRetentionRevision(ref);
			// IPC resumes can finish out of order. Remember selection intent at request
			// admission so a slower, stale resume cannot retire the latest selected runtime.
			// Keep older live intents until retirement so a failed latest resume can fall
			// back to the renderer's previous selection without racing its suspension.
			retainedRefs.set(sessionKey(ref), { ref: { ...ref }, retentionRevision });
			requestedSuspensions.delete(sessionKey(ref));
			void queueSweep();
			return retentionRevision;
		},
		suspendWhenIdle(ref) {
			if (disposed) return;
			retainedRefs.delete(sessionKey(ref));
			const retentionRevision = advanceRetentionRevision(ref);
			requestedSuspensions.set(sessionKey(ref), { ref: { ...ref }, retentionRevision });
			void queueSweep();
		},
		reap() {
			if (disposed) return;
			void queueSweep();
		},
		forget(refs) {
			if (disposed) return;
			for (const ref of refs) {
				const key = sessionKey(ref);
				requestedSuspensions.delete(key);
				retainedRefs.delete(key);
				retentionRevisions.delete(key);
			}
		},
		retire(refs) {
			if (disposed) return [];
			return uniqueSessionRefs(refs).map((ref) => {
				nextRetentionRevision += 1;
				const key = sessionKey(ref);
				requestedSuspensions.delete(key);
				retainedRefs.delete(key);
				retentionRevisions.delete(key);
				return { ref: { ...ref }, retentionRevision: nextRetentionRevision };
			});
		},
		prepareShutdown,
		dispose() {
			if (disposal) return disposal;
			prepareShutdown();
			disposal = activeSweep ?? Promise.resolve();
			return disposal;
		},
	};
}
