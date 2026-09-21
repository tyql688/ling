import { useDomainApi } from "@renderer/lib/host-api-context";
import type { CancelSessionOperationRequest, SessionRef, TranscriptPage } from "@ling/contracts/session";
import { createBuiltinSessionOperationRef, SESSION_TRANSCRIPT_OWNER_ID } from "@ling/contracts/owner-ref";
import { sessionKey } from "@ling/contracts/session-ref";
import {
	captureRendererSessionState,
	isRendererSessionStateCurrent,
} from "@renderer/features/sessions/runtime/renderer-session-state";
import { mergeHistoricalTranscriptPages } from "@renderer/features/sessions/runtime/session-transcript-projection";
import {
	sessionMessagesFamily,
	sessionTranscriptStateFamily,
	type SessionTranscriptState,
} from "@renderer/features/sessions/state/session";
import {
	formatRequestError,
	isExpectedCancellation,
	isTranscriptCursorStale,
	transcriptErrorNeedsSnapshot,
} from "@renderer/lib/errors";
import { useStore } from "jotai";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { createTranscriptPageLoadCoordinator } from "./transcript-page-load-coordinator";

/** Thirty seconds covers a cold bounded transcript page; the Host cancels expired operations. */
const TRANSCRIPT_PAGE_DEADLINE_MS = 30_000;
/** Let initial snapshot invalidations settle for eighty milliseconds before requesting older pages. */
const HISTORY_LOAD_SETTLE_MS = 80;
type HistoryBinding = Pick<SessionTranscriptState, "epoch" | "runtimeId" | "generation" | "chainRevision"> & {
	loadRevision: number;
};

export interface TranscriptHistoryLoad {
	error: string | null;
	loading: boolean;
	retry: () => void;
}

function historyAttemptToken(key: string, state: SessionTranscriptState): string {
	return `${key}:${state.epoch}:${state.runtimeId}:${state.generation}:${state.chainRevision}:${state.olderCursor}`;
}

/** Owns paging, partial progress, retries and cancellation for one mounted session projection. */
export function useTranscriptHistory(
	ref: SessionRef | null,
	transcriptState: SessionTranscriptState,
	safeRefresh: (ref: SessionRef) => void,
): TranscriptHistoryLoad {
	const hostSessionApi = useDomainApi("session");

	const key = ref ? sessionKey(ref) : "";
	const store = useStore();
	const { t } = useTranslation();
	const activePageRequestRef = useRef<CancelSessionOperationRequest | null>(null);
	const pageLoadCoordinatorRef = useRef(createTranscriptPageLoadCoordinator());
	const fullHydrateTokenRef = useRef<string | null>(null);
	const loadRevisionRef = useRef(0);
	const activeLoadRef = useRef<{ key: string; stateToken: symbol; binding: HistoryBinding } | null>(null);
	const updateHistoryState = useCallback(
		(
			stateToken: symbol,
			binding: HistoryBinding,
			update: Partial<Pick<SessionTranscriptState, "historyError" | "historyLoading" | "hydrationSettled">>,
		) => {
			store.set(sessionTranscriptStateFamily(key), (current) => {
				if (
					loadRevisionRef.current !== binding.loadRevision ||
					!isRendererSessionStateCurrent(key, stateToken) ||
					current.epoch !== binding.epoch ||
					current.runtimeId !== binding.runtimeId ||
					current.generation !== binding.generation ||
					current.chainRevision !== binding.chainRevision
				)
					return current;
				return { ...current, ...update };
			});
		},
		[key, store],
	);

	const cancelActivePage = useCallback(() => {
		loadRevisionRef.current += 1;
		pageLoadCoordinatorRef.current.reset();
		const active = activeLoadRef.current;
		activeLoadRef.current = null;
		if (active) {
			store.set(sessionTranscriptStateFamily(active.key), (current) => {
				if (
					!isRendererSessionStateCurrent(active.key, active.stateToken) ||
					current.epoch !== active.binding.epoch ||
					current.runtimeId !== active.binding.runtimeId ||
					current.generation !== active.binding.generation ||
					current.chainRevision !== active.binding.chainRevision
				)
					return current;
				return { ...current, historyLoading: false, hydrationSettled: true };
			});
		}
		const request = activePageRequestRef.current;
		activePageRequestRef.current = null;
		if (!request) return;
		void hostSessionApi.cancelRequest(request).catch(() => {
			// Best-effort cancel; stale page responses are fenced by epoch/generation.
		});
	}, [hostSessionApi, store]);

	useEffect(() => {
		cancelActivePage();
		fullHydrateTokenRef.current = null;
		return cancelActivePage;
	}, [
		cancelActivePage,
		key,
		transcriptState.epoch,
		transcriptState.runtimeId,
		transcriptState.generation,
		transcriptState.chainRevision,
	]);

	const fetchOlderPage = useCallback(
		async (
			stateToken: symbol,
			context: {
				epoch: number;
				runtimeId: string;
				generation: number;
				chainRevision: number;
				cursor: string;
				limit: number;
				loadRevision: number;
			},
		): Promise<TranscriptPage | null> => {
			if (!ref) return null;
			const requestId = crypto.randomUUID();
			const operation = createBuiltinSessionOperationRef(
				requestId,
				SESSION_TRANSCRIPT_OWNER_ID,
				ref,
				context.generation,
			);
			const cancelRequest: CancelSessionOperationRequest = {
				operation,
				ref,
				runtimeId: context.runtimeId,
				generation: context.generation,
			};
			activePageRequestRef.current = cancelRequest;
			const reportError = (message: string) => updateHistoryState(stateToken, context, { historyError: message });
			try {
				const result = await hostSessionApi.readTranscriptPage({
					operation,
					ref,
					runtimeId: context.runtimeId,
					generation: context.generation,
					cursor: context.cursor,
					direction: "older",
					limit: context.limit,
					expectedTranscriptRevision: context.chainRevision,
					deadlineAt: Date.now() + TRANSCRIPT_PAGE_DEADLINE_MS,
				});
				if (loadRevisionRef.current !== context.loadRevision || !isRendererSessionStateCurrent(key, stateToken))
					return null;
				const response = result;
				if (response.requestId !== requestId) {
					reportError(t("session.transcriptResponseMismatch"));
					safeRefresh(ref);
					return null;
				}
				if (response.page.runtimeId !== context.runtimeId || response.page.generation !== context.generation) {
					return null;
				}
				return response.page;
			} catch (cause) {
				if (loadRevisionRef.current !== context.loadRevision || !isRendererSessionStateCurrent(key, stateToken))
					return null;
				const currentState = store.get(sessionTranscriptStateFamily(key));
				const superseded =
					currentState.epoch !== context.epoch ||
					currentState.runtimeId !== context.runtimeId ||
					currentState.generation !== context.generation;
				if (isExpectedCancellation(cause) && superseded) return null;
				if (isTranscriptCursorStale(cause)) {
					safeRefresh(ref);
					return null;
				}
				reportError(formatRequestError(cause));
				if (transcriptErrorNeedsSnapshot(cause)) {
					safeRefresh(ref);
				}
				return null;
			} finally {
				if (activePageRequestRef.current?.operation.requestId === requestId) {
					activePageRequestRef.current = null;
				}
			}
		},
		[hostSessionApi, key, ref, safeRefresh, store, t, updateHistoryState],
	);

	/**
	 * Product rule: open a session → load the entire timeline into renderer memory.
	 * Historical tool results carry summaries; disclosures fetch their bodies separately.
	 * Pages are fetched over IPC, but atoms are written once when the attempt settles
	 * so rendering stays linear and a later failed page does not discard earlier pages.
	 */
	const hydrateFullHistory = useCallback(async (): Promise<boolean> => {
		if (!ref) return false;
		const stateToken = captureRendererSessionState(key);
		const initial = store.get(sessionTranscriptStateFamily(key));
		if (!initial.hasOlder || !initial.olderCursor || !initial.runtimeId || initial.limit <= 0) return false;

		const binding = {
			loadRevision: loadRevisionRef.current,
			epoch: initial.epoch,
			runtimeId: initial.runtimeId,
			generation: initial.generation,
			chainRevision: initial.chainRevision,
		};
		activeLoadRef.current = { key, stateToken, binding };
		const matchesBinding = (latest: { epoch: number; runtimeId: string | null; generation: number }): boolean =>
			loadRevisionRef.current === binding.loadRevision &&
			latest.epoch === binding.epoch &&
			latest.runtimeId === binding.runtimeId &&
			latest.generation === binding.generation;
		const matchesChain = (latest: {
			epoch: number;
			runtimeId: string | null;
			generation: number;
			chainRevision: number;
		}): boolean => matchesBinding(latest) && latest.chainRevision === binding.chainRevision;
		const reportError = (message: string | null) => updateHistoryState(stateToken, binding, { historyError: message });
		updateHistoryState(stateToken, binding, { historyLoading: true, historyError: null });
		const pages: TranscriptPage[] = [];
		let cursor: string | null = initial.olderCursor;
		let hasOlder: boolean = initial.hasOlder;
		const seenCursors = new Set<string>();
		let pagesCommitted = false;
		const commitLoadedPages = (): boolean => {
			if (!isRendererSessionStateCurrent(key, stateToken)) return false;
			const mergeState = store.get(sessionTranscriptStateFamily(key));
			if (!matchesChain(mergeState)) return false;
			const merged = mergeHistoricalTranscriptPages(store.get(sessionMessagesFamily(key)), mergeState, pages);
			if (merged === null) {
				reportError(t("session.transcriptResponseMismatch"));
				return false;
			}
			store.set(sessionMessagesFamily(key), merged);
			store.set(sessionTranscriptStateFamily(key), {
				...mergeState,
				olderCursor: cursor,
				hasOlder,
				hydrationSettled: true,
			});
			pagesCommitted = true;
			return true;
		};

		try {
			while (hasOlder && cursor) {
				if (seenCursors.has(cursor)) {
					reportError(t("session.transcriptResponseMismatch"));
					return false;
				}
				seenCursors.add(cursor);
				if (!isRendererSessionStateCurrent(key, stateToken)) return false;
				const latest = store.get(sessionTranscriptStateFamily(key));
				if (!matchesChain(latest)) return false;
				const page = await fetchOlderPage(stateToken, {
					...binding,
					cursor,
					limit: initial.limit,
				});
				if (!page) return false;
				pages.push(page);
				cursor = page.olderCursor ?? null;
				hasOlder = page.hasOlder;
			}
			if (hasOlder) {
				reportError(t("session.transcriptResponseMismatch"));
				return false;
			}
			if (!commitLoadedPages()) return false;
			reportError(null);
			return true;
		} finally {
			if (activeLoadRef.current?.binding === binding) activeLoadRef.current = null;
			if (!pagesCommitted && pages.length > 0) commitLoadedPages();
			// Success or failure: never leave this binding stuck behind the loading gate.
			store.set(sessionTranscriptStateFamily(key), (latest) => {
				if (!isRendererSessionStateCurrent(key, stateToken) || !matchesChain(latest)) return latest;
				return { ...latest, hydrationSettled: true, historyLoading: false };
			});
		}
	}, [fetchOlderPage, key, ref, store, t, updateHistoryState]);

	const loadHistory = useCallback(() => {
		const current = store.get(sessionTranscriptStateFamily(key));
		if (
			!ref ||
			current.historyLoading ||
			!current.hasOlder ||
			!current.olderCursor ||
			!current.runtimeId ||
			current.limit <= 0
		)
			return;
		const stateToken = captureRendererSessionState(key);
		const binding = { ...current, loadRevision: loadRevisionRef.current };
		fullHydrateTokenRef.current = historyAttemptToken(key, current);
		void pageLoadCoordinatorRef.current.run(hydrateFullHistory).catch((cause: unknown) => {
			updateHistoryState(stateToken, binding, {
				historyError: formatRequestError(cause),
				historyLoading: false,
				hydrationSettled: true,
			});
		});
	}, [hydrateFullHistory, key, ref, store, updateHistoryState]);

	const automaticAttemptToken = historyAttemptToken(key, transcriptState);
	// One automatic attempt per cursor; failures wait for an explicit retry.
	// Live revision updates must not postpone the timer.
	useEffect(() => {
		if (
			!ref ||
			transcriptState.historyError !== null ||
			transcriptState.historyLoading ||
			!transcriptState.hasOlder ||
			!transcriptState.olderCursor ||
			!transcriptState.runtimeId ||
			transcriptState.limit <= 0
		)
			return;
		if (fullHydrateTokenRef.current === automaticAttemptToken) return;
		const timer = window.setTimeout(loadHistory, HISTORY_LOAD_SETTLE_MS);
		return () => window.clearTimeout(timer);
	}, [
		automaticAttemptToken,
		loadHistory,
		ref,
		transcriptState.historyError,
		transcriptState.historyLoading,
		transcriptState.hasOlder,
		transcriptState.olderCursor,
		transcriptState.runtimeId,
		transcriptState.limit,
	]);

	return useMemo(
		() => ({
			error: transcriptState.historyError,
			loading: transcriptState.historyLoading,
			retry: loadHistory,
		}),
		[transcriptState.historyError, transcriptState.historyLoading, loadHistory],
	);
}
