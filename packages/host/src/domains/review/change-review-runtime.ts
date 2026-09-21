import type { SessionRef } from "@ling/contracts/session";
import { sessionKey } from "@ling/contracts/session-ref";
import type { ProjectFileWatchers } from "@ling/host/domains/review/project-file-watcher";
import { getGitReviewSnapshot, type GitReviewSnapshot } from "@ling/host/domains/git/git-service";
import { requestCancelled, throwAggregateFailures } from "@ling/core/ling-error";
import { createLogger } from "@ling/core/logger";
import { pathIdentity } from "@ling/core/paths";
import { getHostRuntimePaths } from "@ling/host/runtime/runtime-paths";
import type { PiWorkerClient } from "../../workers/pi/pi-worker-client";
import {
	cleanupStaleShadowGitData,
	createShadowGitSession,
	deleteShadowGitSessionData,
	type ShadowGitSession,
} from "./change-review-shadow";
import type { ChangeReviewRuntimeState } from "./change-review-state";
import { withoutPatches, type ChangeReviewStore } from "./change-review-store";

/**
 * Debounce for merging live recomputes after workspace file changes. Bursts from the
 * watcher collapse into one run within 120ms; shorter would still flap with every disk
 * write, longer makes the sidebar change count feel laggy.
 */
const LIVE_UPDATE_DEBOUNCE_MS = 120;
const log = createLogger("change-review-runtime");

export interface ChangeReviewRuntimeOwner {
	runForSession<Result>(ref: SessionRef, operation: () => Promise<Result>): Promise<Result>;
	runForOpenProjectSession<Result>(
		ref: SessionRef,
		operation: (canonicalRef: SessionRef) => Promise<Result>,
	): Promise<Result>;
	capture(cwd: string, signal?: AbortSignal): Promise<GitReviewSnapshot>;
	ensureState(ref: SessionRef): Promise<ChangeReviewRuntimeState>;
	alignRepositoryMode(state: ChangeReviewRuntimeState, current: GitReviewSnapshot): Promise<void>;
	ensureShadowSession(state: ChangeReviewRuntimeState): ShadowGitSession;
	retireFailedShadowSession(state: ChangeReviewRuntimeState): Promise<void>;
	scheduleLiveUpdate(state: ChangeReviewRuntimeState): void;
	onLiveUpdate(ref: SessionRef, listener: () => void): () => void;
	stateFor(ref: SessionRef): ChangeReviewRuntimeState | undefined;
	hasState(ref: SessionRef): boolean;
	adoptState(state: ChangeReviewRuntimeState): void;
	discardState(state: ChangeReviewRuntimeState): Promise<void>;
	workspaceWriteKey(ref: SessionRef): string;
	releaseSession(ref: SessionRef): Promise<void>;
	releaseProject(cwd: string): Promise<void>;
	deleteSessionState(ref: SessionRef): Promise<void>;
	initialize(): Promise<void>;
	shutdown(): Promise<void>;
}

export function createChangeReviewRuntimeOwner({
	store,
	withProject,
	watchers,
}: {
	withProject: PiWorkerClient["withProject"];
	watchers: ProjectFileWatchers;
	store: Pick<ChangeReviewStore, "loadState" | "persist">;
}): ChangeReviewRuntimeOwner {
	const { loadState, persist } = store;
	/**
	 * Startup GC of crash-orphaned shadow repositories, held as a barrier rather than awaited
	 * before the window. It deletes by mtime, so it has to finish before a session can adopt a
	 * shadow directory it was about to remove; `ensureState` is the only way one is reached.
	 * Never rejects — `initialize` hands the real failure to its caller to report.
	 */
	let staleShadowDataCleaned: Promise<void> = Promise.resolve();
	let stopping = false;
	let disposal: Promise<void> | null = null;
	const states = new Map<string, ChangeReviewRuntimeState>();
	const sessionOperationQueues = new Map<string, Promise<void>>();
	const liveUpdateListeners = new Map<string, Set<() => void>>();
	const pendingWatcherInvalidations = new WeakSet<ChangeReviewRuntimeState>();

	const runForSession = <Result>(ref: SessionRef, operation: () => Promise<Result>): Promise<Result> => {
		if (stopping) return Promise.reject(requestCancelled("Change review runtime has been disposed."));
		const key = sessionKey(ref);
		const previous = sessionOperationQueues.get(key);
		const result = previous === undefined ? Promise.resolve().then(operation) : previous.then(operation);
		const settled = result.then(
			() => undefined,
			() => undefined,
		);
		sessionOperationQueues.set(key, settled);
		return result.finally(() => {
			if (sessionOperationQueues.get(key) === settled) {
				sessionOperationQueues.delete(key);
			}
		});
	};

	const runForOpenProjectSession = <Result>(
		ref: SessionRef,
		operation: (canonicalRef: SessionRef) => Promise<Result>,
	): Promise<Result> =>
		withProject(ref.cwd, (canonicalCwd) => {
			const canonicalRef = canonicalCwd === ref.cwd ? ref : { ...ref, cwd: canonicalCwd };
			return runForSession(canonicalRef, () => operation(canonicalRef));
		});

	const publishLiveUpdate = (ref: SessionRef): void => {
		for (const listener of liveUpdateListeners.get(sessionKey(ref)) ?? []) {
			try {
				listener();
			} catch {
				// Browser-window forwarding owns its own logging and lifecycle.
			}
		}
	};

	const scheduleLiveUpdate = (state: ChangeReviewRuntimeState): void => {
		if (state.liveUpdateTimer) {
			clearTimeout(state.liveUpdateTimer);
		}
		state.liveUpdateTimer = setTimeout(() => {
			state.liveUpdateTimer = undefined;
			if (states.get(sessionKey(state.ref)) === state) {
				publishLiveUpdate(state.ref);
			}
		}, LIVE_UPDATE_DEBOUNCE_MS);
	};

	const recordProjectFileActivity = (state: ChangeReviewRuntimeState): void => {
		if (stopping) return;
		if (pendingWatcherInvalidations.has(state)) return;
		pendingWatcherInvalidations.add(state);
		void runForSession(state.ref, async () => {
			if (states.get(sessionKey(state.ref)) !== state) return;
			state.computed = undefined;
			scheduleLiveUpdate(state);
		})
			.finally(() => pendingWatcherInvalidations.delete(state))
			.catch((error: unknown) => {
				log.error("Project file activity could not refresh change review:", error);
			});
	};

	const installRuntimeInfrastructure = (state: ChangeReviewRuntimeState): void => {
		if (state.watcher) return;
		const watcher = watchers.acquire(state.cwd, () => recordProjectFileActivity(state));
		state.watcher = watcher;
		void watcher.ready.catch(() => {
			// Shadow Git remains authoritative. A failed watcher only disables
			// automatic refresh; explicit and final captures still work.
		});
	};

	const disposeRuntimeInfrastructure = async (state: ChangeReviewRuntimeState): Promise<void> => {
		if (state.liveUpdateTimer) {
			clearTimeout(state.liveUpdateTimer);
			state.liveUpdateTimer = undefined;
		}
		const watcher = state.watcher;
		state.watcher = undefined;
		const shadow = state.shadow;
		state.shadow = undefined;
		const results = await Promise.allSettled([
			watcher?.dispose() ?? Promise.resolve(),
			shadow?.dispose() ?? Promise.resolve(),
		]);
		throwAggregateFailures(
			results.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
			"Failed to dispose change review infrastructure",
		);
	};

	const ensureState = async (ref: SessionRef): Promise<ChangeReviewRuntimeState> => {
		await staleShadowDataCleaned;
		const key = sessionKey(ref);
		const existing = states.get(key);
		if (existing) return existing;
		const loaded = await loadState(ref);
		if (loaded) {
			states.set(key, loaded);
			installRuntimeInfrastructure(loaded);
			return loaded;
		}
		const baseline = withoutPatches(await getGitReviewSnapshot(ref.cwd));
		const state: ChangeReviewRuntimeState = {
			ref,
			cwd: ref.cwd,
			baseline,
			turns: [],
		};
		states.set(key, state);
		try {
			await persist(state);
			installRuntimeInfrastructure(state);
		} catch (error) {
			if (states.get(key) === state) states.delete(key);
			await disposeRuntimeInfrastructure(state).catch(() => {});
			throw error;
		}
		return state;
	};

	const alignRepositoryMode = async (state: ChangeReviewRuntimeState, current: GitReviewSnapshot): Promise<void> => {
		if (state.baseline.isRepository === current.isRepository) {
			return;
		}
		const previous = {
			baseline: state.baseline,
			turns: state.turns,
			activeTurn: state.activeTurn,
			computed: state.computed,
		};
		state.baseline = withoutPatches(current);
		state.turns = [];
		state.activeTurn = undefined;
		state.computed = undefined;
		try {
			await persist(state);
		} catch (error) {
			state.baseline = previous.baseline;
			state.turns = previous.turns;
			state.activeTurn = previous.activeTurn;
			state.computed = previous.computed;
			throw error;
		}
	};

	const runtime: ChangeReviewRuntimeOwner = {
		runForSession,
		runForOpenProjectSession,
		capture: (cwd, signal) => getGitReviewSnapshot(cwd, signal),
		ensureState,
		alignRepositoryMode,
		ensureShadowSession(state) {
			const shadow = state.shadow ?? createShadowGitSession(getHostRuntimePaths().userDataDir, state.ref);
			state.shadow = shadow;
			return shadow;
		},
		async retireFailedShadowSession(state) {
			const shadow = state.shadow;
			state.shadow = undefined;
			if (!shadow) return;
			try {
				await shadow.dispose();
			} catch {
				// The capture failure remains the useful diagnosis. Startup cleanup
				// bounds any crash residue.
			}
		},
		scheduleLiveUpdate,
		onLiveUpdate(ref, listener) {
			const key = sessionKey(ref);
			const listeners = liveUpdateListeners.get(key) ?? new Set<() => void>();
			listeners.add(listener);
			liveUpdateListeners.set(key, listeners);
			return () => {
				listeners.delete(listener);
				if (listeners.size === 0 && liveUpdateListeners.get(key) === listeners) {
					liveUpdateListeners.delete(key);
				}
			};
		},
		stateFor: (ref) => states.get(sessionKey(ref)),
		hasState: (ref) => states.has(sessionKey(ref)),
		adoptState(state) {
			const key = sessionKey(state.ref);
			if (states.has(key)) {
				throw new Error(`Change review state is already active for ${state.ref.sessionId}`);
			}
			states.set(key, state);
			installRuntimeInfrastructure(state);
		},
		async discardState(state) {
			const key = sessionKey(state.ref);
			if (states.get(key) === state) states.delete(key);
			await disposeRuntimeInfrastructure(state);
		},
		workspaceWriteKey(ref) {
			const state = states.get(sessionKey(ref));
			return state?.computed?.dto.gitRoot ?? state?.baseline.gitRoot ?? ref.cwd;
		},
		releaseSession(ref) {
			return runForSession(ref, async () => {
				const key = sessionKey(ref);
				const state = states.get(key);
				states.delete(key);
				if (state) await disposeRuntimeInfrastructure(state);
			});
		},
		async releaseProject(cwd) {
			const identity = pathIdentity(cwd);
			const refs = [...states.values()]
				.filter((state) => pathIdentity(state.cwd) === identity)
				.map((state) => state.ref);
			await Promise.all(refs.map((ref) => runtime.releaseSession(ref)));
		},
		deleteSessionState(ref) {
			return runForSession(ref, async () => {
				const key = sessionKey(ref);
				const state = states.get(key);
				states.delete(key);
				if (state) await disposeRuntimeInfrastructure(state);
				// Catalog cleanup owns the single transaction that removes every session metadata row.
				await deleteShadowGitSessionData(getHostRuntimePaths().userDataDir, ref);
			});
		},
		initialize() {
			const cleaning = cleanupStaleShadowGitData(getHostRuntimePaths().userDataDir);
			staleShadowDataCleaned = cleaning.catch(() => undefined);
			return cleaning;
		},
		shutdown() {
			if (disposal) return disposal;
			stopping = true;
			disposal = (async () => {
				// Each request owns its failure; retirement waits until it stops touching state.
				await Promise.all([...sessionOperationQueues.values()]);
				const active = [...states.values()];
				states.clear();
				const sessionResults = await Promise.allSettled(active.map(disposeRuntimeInfrastructure));
				throwAggregateFailures(
					sessionResults.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
					"Failed to shut down change review infrastructure",
				);
			})();
			return disposal;
		},
	};

	return runtime;
}
