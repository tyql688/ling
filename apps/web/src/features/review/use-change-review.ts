import { useDomainApi } from "@renderer/lib/host-api-context";
import { useDataIssue } from "@renderer/lib/data-health/state";
import type { ChangeReviewSnapshot } from "@ling/contracts/git";
import { type SessionRef, sameSessionRef, sessionKey } from "@ling/contracts/session-ref";
import { onRendererSessionStateEvicted } from "@renderer/features/sessions/runtime/renderer-session-state";
import { sessionTranscriptStateFamily } from "@renderer/features/sessions/state/session";
import { datasetStoreIssue } from "@renderer/lib/dataset-status";
import { formatRequestError } from "@renderer/lib/errors";
import { useStore } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { createChangeReviewRequestGuard, runLatestChangeReviewRequest } from "./change-review-request";
import { forgetReviewedMaps } from "./change-review-reviewed";

interface TimelineReviewCacheEntry {
	turns: ChangeReviewSnapshot["turns"];
}

/** Turn cards only affect timeline layout; keep recent sessions cached so A→B→A does not briefly lose a batch of cards before they come back. */
const MAX_TIMELINE_REVIEW_CACHE_ENTRIES = 20;

/** Evicts oldest-first until the cache is back within its entry bound. */
function trimTimelineCache<T>(next: Map<string, T>): Map<string, T> {
	while (next.size > MAX_TIMELINE_REVIEW_CACHE_ENTRIES) {
		const oldest = next.keys().next().value;
		if (oldest === undefined) break;
		next.delete(oldest);
	}
	return next;
}
const EMPTY_TIMELINE_TURNS: ChangeReviewSnapshot["turns"] = [];

export function useChangeReview(ref: SessionRef | null, knownEmptyTimelineSeedPending: boolean) {
	const hostChangeReviewApi = useDomainApi("changeReview");

	const { t } = useTranslation();
	const key = ref ? sessionKey(ref) : "";
	const store = useStore();
	const [snapshotState, setSnapshotState] = useState<{ key: string; value: ChangeReviewSnapshot } | null>(null);
	const snapshot = snapshotState?.key === key ? snapshotState.value : null;
	const [timelineCache, setTimelineCache] = useState<ReadonlyMap<string, TimelineReviewCacheEntry>>(() => new Map());
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [stateRecoveryError, setStateRecoveryError] = useState<string | null>(null);
	const [stateRecoveryAllowed, setStateRecoveryAllowed] = useState(false);
	const [repairingState, setRepairingState] = useState(false);
	const requestGuard = useRef<ReturnType<typeof createChangeReviewRequestGuard> | null>(null);
	const guard = requestGuard.current ?? createChangeReviewRequestGuard();
	requestGuard.current = guard;
	guard.activate(ref);

	const rememberTimelineTurns = useCallback((targetRef: SessionRef, turns: ChangeReviewSnapshot["turns"]) => {
		const targetKey = sessionKey(targetRef);
		setTimelineCache((current) => {
			const existing = current.get(targetKey);
			if (existing?.turns === turns) return current;
			const next = new Map(current);
			next.delete(targetKey);
			next.set(targetKey, { turns });
			return trimTimelineCache(next);
		});
	}, []);

	const markTimelineReady = useCallback((targetRef: SessionRef) => {
		const targetKey = sessionKey(targetRef);
		setTimelineCache((current) => {
			if (current.has(targetKey)) return current;
			const next = new Map(current);
			next.set(targetKey, { turns: [] });
			return trimTimelineCache(next);
		});
	}, []);

	const load = useCallback(async () => {
		if (!ref) return;
		await runLatestChangeReviewRequest({
			guard,
			ref,
			load: async () => {
				const status = await hostChangeReviewApi.stateStatus(ref);
				const issue = datasetStoreIssue(status, (key, options) => (options === undefined ? t(key) : t(key, options)));
				if (issue) return { type: "stateIssue" as const, issue };
				const next = await hostChangeReviewApi.getSnapshot(ref);
				return { type: "snapshot" as const, value: next };
			},
			onStart: () => {
				setLoading(true);
				setRepairingState(false);
			},
			onSuccess: (next) => {
				if (next.type === "stateIssue") {
					setSnapshotState(null);
					markTimelineReady(ref);
					setStateRecoveryError(next.issue.message);
					setStateRecoveryAllowed(next.issue.recoverable);
					setError(null);
					return;
				}
				setSnapshotState({ key: sessionKey(ref), value: next.value });
				rememberTimelineTurns(ref, next.value.turns);
				setStateRecoveryError(null);
				setStateRecoveryAllowed(false);
				setError(null);
			},
			onError: (cause) => {
				markTimelineReady(ref);
				setError(formatRequestError(cause));
			},
			onSettled: () => setLoading(false),
		});
	}, [hostChangeReviewApi, guard, markTimelineReady, ref, rememberTimelineTurns, t]);

	const refresh = useCallback(async () => {
		if (!ref) return;
		await load();
	}, [load, ref]);

	const repairState = useCallback(async (): Promise<void> => {
		if (!ref) return;
		await runLatestChangeReviewRequest({
			guard,
			ref,
			load: () => hostChangeReviewApi.resetState(ref),
			onStart: () => setRepairingState(true),
			onSuccess: (next) => {
				setSnapshotState({ key: sessionKey(ref), value: next });
				rememberTimelineTurns(ref, next.turns);
				setStateRecoveryError(null);
				setStateRecoveryAllowed(false);
				setError(null);
			},
			onError: (cause) => setError(formatRequestError(cause)),
			onSettled: () => setRepairingState(false),
		});
	}, [hostChangeReviewApi, guard, ref, rememberTimelineTurns]);

	useDataIssue(
		`review:${key}`,
		stateRecoveryError
			? {
					label: t("changes.stateReadErrorTitle"),
					message: stateRecoveryError,
					retry: refresh,
					...(stateRecoveryAllowed
						? {
								recovery: {
									label: t("changes.stateRepair"),
									description: t("changes.stateRepairConfirm"),
									run: repairState,
								},
							}
						: {}),
				}
			: null,
	);
	useEffect(
		() =>
			onRendererSessionStateEvicted((keys) => {
				forgetReviewedMaps(keys);
				const evicted = new Set(keys);
				setTimelineCache((current) => {
					if (![...current.keys()].some((entryKey) => evicted.has(entryKey))) return current;
					const next = new Map(current);
					for (const entryKey of evicted) next.delete(entryKey);
					return next;
				});
			}),
		[],
	);

	useEffect(() => {
		if (!ref || !knownEmptyTimelineSeedPending) return;
		markTimelineReady(ref);
	}, [knownEmptyTimelineSeedPending, markTimelineReady, ref]);

	useEffect(() => {
		if (!ref || !knownEmptyTimelineSeedPending || !timelineCache.has(key)) return;
		store.set(sessionTranscriptStateFamily(key), (current) =>
			current.knownEmptySeedPending ? { ...current, knownEmptySeedPending: false } : current,
		);
	}, [key, knownEmptyTimelineSeedPending, ref, store, timelineCache]);

	useEffect(() => {
		setSnapshotState(null);
		setError(null);
		setStateRecoveryError(null);
		setStateRecoveryAllowed(false);
		setRepairingState(false);
		if (!ref) {
			setLoading(false);
			return;
		}
		guard.activate(ref);
		void load();
		return () => {
			guard.deactivate(ref);
		};
	}, [guard, load, ref]);

	useEffect(() => {
		if (!ref) return;
		return hostChangeReviewApi.onTrackingEvent((event) => {
			if (!sameSessionRef(event.ref, ref)) return;
			if (event.type === "started") {
				// Never carry the previous request's files into a newly-started assistant run.
				guard.begin(ref);
				setSnapshotState(null);
				setLoading(false);
				setRepairingState(false);
				setError(null);
				// Host has established the new baseline before publishing started. Load it now
				// so reading and navigation remain usable while a tool waits for approval.
				void refresh();
				return;
			}
			if (event.type === "failed") {
				guard.begin(ref);
				setSnapshotState(null);
				setLoading(false);
				setRepairingState(false);
				setError(t("changes.trackingFailed"));
				return;
			}
			void refresh();
		});
	}, [hostChangeReviewApi, guard, ref, refresh, t]);

	return useMemo(
		() => ({
			snapshot,
			timelineTurns: key
				? (timelineCache.get(key)?.turns ?? (knownEmptyTimelineSeedPending ? EMPTY_TIMELINE_TURNS : null))
				: null,
			timelineReady: key.length > 0 && (knownEmptyTimelineSeedPending || timelineCache.has(key)),
			loading,
			error,
			stateRecoveryError,
			stateRecoveryAllowed,
			repairingState,
			repairState,
			refresh,
		}),
		[
			snapshot,
			key,
			timelineCache,
			knownEmptyTimelineSeedPending,
			loading,
			error,
			stateRecoveryError,
			stateRecoveryAllowed,
			repairingState,
			repairState,
			refresh,
		],
	);
}
