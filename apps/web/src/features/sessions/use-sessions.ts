import { useDomainApi } from "@renderer/lib/host-api-context";
import { useDataIssue } from "@renderer/lib/data-health/state";
import type { CreateSessionRequest, SessionSummary } from "@ling/contracts/session";
import { sameSessionRef, sessionKey, toSessionRef, type SessionRef } from "@ling/contracts/session-ref";
import { wakeRendererSessionState } from "@renderer/features/sessions/runtime/renderer-session-state";
import { markTranscriptKnownEmpty } from "@renderer/features/sessions/runtime/session-transcript-projection";
import {
	activeSessionRefAtom,
	sessionsAtom,
	sessionTranscriptStateFamily,
} from "@renderer/features/sessions/state/session";
import { datasetStoreIssue } from "@renderer/lib/dataset-status";
import { formatRequestError, isProjectDirectoryMissing } from "@renderer/lib/errors";
import { archivedTranscriptsAtom } from "./archived-session-state";
import { createRequestFence, type RequestFence } from "@renderer/lib/request-fence";
import { useAtom, useStore } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { applySessionSummaryChanged } from "./session-catalog-events";
import { projectReplacementActiveRef, projectReplacementSessions } from "./session-replacement";

const SESSION_LIST_IDENTITY = "sessions";

export function useSessions({ onSessionsRemoved }: { onSessionsRemoved(refs: readonly SessionRef[]): void }) {
	const hostSessionApi = useDomainApi("session");

	const { t } = useTranslation();
	const [sessions, setSessions] = useAtom(sessionsAtom);
	const [activeSessionRef, setActiveSessionRef] = useAtom(activeSessionRefAtom);
	const [error, setError] = useState<string | null>(null);
	const [catalogRecoveryError, setCatalogRecoveryError] = useState<string | null>(null);
	const [catalogRecoveryAllowed, setCatalogRecoveryAllowed] = useState(false);
	const [catalogPersistenceDegraded, setCatalogPersistenceDegraded] = useState(false);
	const [repairingCatalog, setRepairingCatalog] = useState(false);
	const [openingSessionKey, setOpeningSessionKey] = useState<string | null>(null);
	const selectionIntentIdRef = useRef(0);
	const store = useStore();
	const refreshFenceRef = useRef<RequestFence<typeof SESSION_LIST_IDENTITY> | null>(null);
	refreshFenceRef.current ??= createRequestFence<typeof SESSION_LIST_IDENTITY>();
	const refreshFence = refreshFenceRef.current;

	const refresh = useCallback(async () => {
		const request = refreshFence.begin(SESSION_LIST_IDENTITY);
		try {
			const catalogStatus = await hostSessionApi.catalogStatus();
			if (!refreshFence.isCurrent(request, SESSION_LIST_IDENTITY)) return;
			if (catalogStatus.status === "degraded") {
				setCatalogRecoveryError(t("session.catalogPersistErrorDescription"));
				setCatalogRecoveryAllowed(false);
				setCatalogPersistenceDegraded(true);
				setError(null);
				return;
			}
			const issue = datasetStoreIssue(catalogStatus, (key, options) =>
				options === undefined ? t(key) : t(key, options),
			);
			if (issue) {
				setCatalogRecoveryError(issue.message);
				setCatalogRecoveryAllowed(issue.recoverable);
				setCatalogPersistenceDegraded(false);
				setError(null);
				return;
			}
			const list = await hostSessionApi.list();
			if (!refreshFence.isCurrent(request, SESSION_LIST_IDENTITY)) return;
			// Sessions whose auto-title hasn't landed yet come back with an empty title (the default
			// name is never persisted — see core/session-manager/session-manager.ts) — show the localized label.
			const next = list.map((s) => (s.title ? s : { ...s, title: t("session.untitled") }));
			const nextKeys = new Set(next.map((session) => sessionKey(toSessionRef(session))));
			const removed = store
				.get(sessionsAtom)
				.map(toSessionRef)
				.filter((ref) => !nextKeys.has(sessionKey(ref)));
			onSessionsRemoved(removed);
			setSessions(next);
			setCatalogRecoveryError(null);
			setCatalogRecoveryAllowed(false);
			setCatalogPersistenceDegraded(false);
			setError(null);
		} catch (cause) {
			if (!refreshFence.isCurrent(request, SESSION_LIST_IDENTITY)) return;
			const catalogStatus = await hostSessionApi.catalogStatus().catch(() => null);
			if (!refreshFence.isCurrent(request, SESSION_LIST_IDENTITY)) return;
			if (catalogStatus?.status === "degraded") {
				setCatalogRecoveryError(t("session.catalogPersistErrorDescription"));
				setCatalogRecoveryAllowed(false);
				setCatalogPersistenceDegraded(true);
			}
			setError(formatRequestError(cause));
			return { status: "error" as const, error: cause };
		}
	}, [hostSessionApi, onSessionsRemoved, refreshFence, setSessions, store, t]);

	const repairSessionCatalog = useCallback(async (): Promise<void> => {
		setRepairingCatalog(true);
		try {
			await hostSessionApi.rebuildCatalog();
			await refresh();
		} catch (cause) {
			setError(formatRequestError(cause));
		} finally {
			setRepairingCatalog(false);
		}
	}, [hostSessionApi, refresh]);

	const retrySessionCatalogPersistence = useCallback(async (): Promise<void> => {
		setRepairingCatalog(true);
		try {
			await hostSessionApi.retryCatalogPersistence();
			await refresh();
		} catch (cause) {
			setError(formatRequestError(cause));
		} finally {
			setRepairingCatalog(false);
		}
	}, [hostSessionApi, refresh]);

	useDataIssue(
		"ling/session-catalog",
		catalogRecoveryError
			? {
					label: t("session.catalogReadErrorTitle"),
					message: catalogRecoveryError,
					retry: retrySessionCatalogPersistence,
					...(catalogRecoveryAllowed
						? {
								recovery: {
									label: t("session.catalogRepair"),
									description: t("session.catalogRepairConfirm"),
									run: repairSessionCatalog,
								},
							}
						: {}),
				}
			: null,
	);
	useEffect(() => {
		void refresh();
		return () => refreshFence.invalidate();
	}, [refresh, refreshFence]);

	useEffect(
		() =>
			hostSessionApi.onCatalogChanged((change) => {
				refreshFence.invalidate();
				if (change.type === "changed") {
					void refresh();
					return;
				}
				setSessions((current) => current.filter((session) => !sameSessionRef(toSessionRef(session), change.ref)));
				onSessionsRemoved([change.ref]);
			}),
		[hostSessionApi, onSessionsRemoved, refresh, refreshFence, setSessions],
	);

	// Auto-titling (see core/session-manager/session-manager.ts) runs in the background after a session's first
	// turn — patch the sidebar's title in place when it lands, rather than re-fetching the list.
	useEffect(() => {
		return hostSessionApi.onTitleChanged(({ ref, title }) => {
			setSessions((current) => current.map((s) => (sameSessionRef(toSessionRef(s), ref) ? { ...s, title } : s)));
		});
	}, [hostSessionApi, setSessions]);

	useEffect(() => {
		return hostSessionApi.onEvent((envelope) => {
			if (envelope.event.type === "sessionSummaryChanged") {
				const summary = envelope.event.summary;
				setSessions((current) => applySessionSummaryChanged(current, summary, t("session.untitled")));
				return;
			}
			if (envelope.event.type === "sessionReplaced") {
				const replacement = { previousRef: envelope.event.previousRef, nextRef: envelope.ref };
				const now = Date.now();
				setSessions((current) => projectReplacementSessions(current, replacement, t("session.untitled"), now));
				setActiveSessionRef((current) => projectReplacementActiveRef(current, replacement));
				return;
			}
			if (envelope.event.type === "sessionCatalogChanged") void refresh();
		});
	}, [hostSessionApi, refresh, setActiveSessionRef, setSessions, t]);

	// Safety net for anything that removes sessions in bulk without going through
	// `deleteSession` below (e.g. closing a whole project) — never leave `activeSessionRef`
	// pointing at a session that no longer exists in the list.
	useEffect(() => {
		if (activeSessionRef && !sessions.some((s) => sameSessionRef(toSessionRef(s), activeSessionRef))) {
			selectionIntentIdRef.current += 1;
			setActiveSessionRef(null);
		}
	}, [sessions, activeSessionRef, setActiveSessionRef]);

	const registerNewSession = useCallback(
		(summary: SessionSummary) => {
			refreshFence.invalidate();
			selectionIntentIdRef.current += 1;
			setSessions((current) => [
				summary,
				...current.filter((session) => !sameSessionRef(toSessionRef(session), toSessionRef(summary))),
			]);
			setActiveSessionRef(toSessionRef(summary));
		},
		[refreshFence, setSessions, setActiveSessionRef],
	);

	const createSession = useCallback(
		async (cwd: string, initial: Pick<CreateSessionRequest, "model" | "thinkingLevel"> = {}) => {
			const summary = await hostSessionApi.create({ cwd, title: t("session.untitled"), ...initial });
			const key = sessionKey(toSessionRef(summary));
			store.set(sessionTranscriptStateFamily(key), markTranscriptKnownEmpty);
			registerNewSession(summary);
			return summary;
		},
		[hostSessionApi, registerNewSession, store, t],
	);

	/**
	 * Binds a runtime, or reads the session from its file when the project folder is gone. Returns
	 * false for an archived read so callers skip the runtime-bound follow-up work.
	 */
	const resumeOrArchive = useCallback(
		async (ref: SessionRef): Promise<boolean> => {
			try {
				const { retentionRevision } = await hostSessionApi.resume({ ref });
				wakeRendererSessionState(store, ref, retentionRevision);
				return true;
			} catch (cause) {
				if (!isProjectDirectoryMissing(cause)) throw cause;
				const key = sessionKey(ref);
				// Claim the session before the read so no runtime-bound surface mounts meanwhile.
				store.set(archivedTranscriptsAtom, (current) => new Map(current).set(key, null));
				const transcript = await hostSessionApi.readArchivedTranscript({ ref, markdownWidth: 0 });
				store.set(archivedTranscriptsAtom, (current) => new Map(current).set(key, transcript));
				return false;
			}
		},
		[hostSessionApi, store],
	);

	const selectSession = useCallback(
		async (ref: SessionRef) => {
			const selectionIntentId = ++selectionIntentIdRef.current;
			const knownSession = store.get(sessionsAtom).some((session) => sameSessionRef(toSessionRef(session), ref));
			if (!knownSession) {
				await resumeOrArchive(ref);
				await refresh();
				if (selectionIntentIdRef.current === selectionIntentId) setActiveSessionRef(ref);
				return;
			}

			// Paint selection + loading before runtime I/O, but don't mount session-bound
			// surfaces until resume succeeds (they would issue snapshot/editor IPC too early).
			const key = sessionKey(ref);
			const currentRef = store.get(activeSessionRefAtom);
			const currentTranscriptState =
				currentRef === null ? null : store.get(sessionTranscriptStateFamily(sessionKey(currentRef)));
			const currentRuntimeReady =
				currentTranscriptState !== null &&
				(currentTranscriptState.runtimeId !== null || currentTranscriptState.hydrationSettled);
			if (sameSessionRef(currentRef, ref) && currentRuntimeReady) return;
			const previousRef = currentRuntimeReady ? currentRef : null;
			setOpeningSessionKey(key);
			setActiveSessionRef(ref);
			try {
				await resumeOrArchive(ref);
			} catch (cause) {
				if (selectionIntentIdRef.current === selectionIntentId) {
					setActiveSessionRef((current) => (sameSessionRef(current, ref) ? previousRef : current));
				}
				throw cause;
			} finally {
				setOpeningSessionKey((current) => (current === key ? null : current));
			}
		},
		[refresh, resumeOrArchive, setActiveSessionRef, store],
	);

	const forkSession = useCallback(
		async (ref: SessionRef, entryId: string) => {
			const summary = await hostSessionApi.fork({ ref, entryId });
			registerNewSession(summary);
			return summary;
		},
		[hostSessionApi, registerNewSession],
	);

	const deleteSession = useCallback(
		async (ref: SessionRef) => {
			const outcome = await hostSessionApi.delete(ref);
			refreshFence.invalidate();
			const key = sessionKey(ref);
			setSessions((current) => current.filter((s) => sessionKey(toSessionRef(s)) !== key));
			onSessionsRemoved([ref]);
			setError(outcome.status === "deleted-with-warning" ? outcome.warning : null);
		},
		[hostSessionApi, onSessionsRemoved, refreshFence, setSessions],
	);

	const setSessionPinned = useCallback(
		async (ref: SessionRef, pinned: boolean) => {
			try {
				const list = await hostSessionApi.setPinned({ ref, pinned });
				refreshFence.invalidate();
				setSessions(list.map((s) => (s.title ? s : { ...s, title: t("session.untitled") })));
			} catch (cause) {
				await refresh();
				throw cause;
			}
		},
		[hostSessionApi, refresh, refreshFence, setSessions, t],
	);

	const setSessionArchived = useCallback(
		async (ref: SessionRef, archived: boolean) => {
			try {
				const list = await hostSessionApi.setArchived({ ref, archived });
				refreshFence.invalidate();
				setSessions(list.map((s) => (s.title ? s : { ...s, title: t("session.untitled") })));
				if (archived && sameSessionRef(activeSessionRef, ref)) {
					selectionIntentIdRef.current += 1;
					setActiveSessionRef(null);
				}
			} catch (cause) {
				await refresh();
				throw cause;
			}
		},
		[hostSessionApi, activeSessionRef, refresh, refreshFence, setActiveSessionRef, setSessions, t],
	);

	/** Back to the home screen — "new conversation" shows the quick-start view; nothing is created
	 * until the first message actually sends (see workspace session actions' handleHomeStart). */
	const deselectSession = useCallback(() => {
		selectionIntentIdRef.current += 1;
		setActiveSessionRef(null);
	}, [setActiveSessionRef]);

	return useMemo(
		() => ({
			sessions,
			activeSessionRef,
			openingSessionKey,
			refresh,
			createSession,
			selectSession,
			deselectSession,
			forkSession,
			deleteSession,
			setSessionPinned,
			setSessionArchived,
			catalogRecoveryError,
			catalogRecoveryAllowed,
			catalogPersistenceDegraded,
			repairingCatalog,
			repairSessionCatalog,
			retrySessionCatalogPersistence,
			error,
			reportError: setError,
		}),
		[
			sessions,
			activeSessionRef,
			openingSessionKey,
			refresh,
			createSession,
			selectSession,
			deselectSession,
			forkSession,
			deleteSession,
			setSessionPinned,
			setSessionArchived,
			catalogRecoveryError,
			catalogRecoveryAllowed,
			catalogPersistenceDegraded,
			repairingCatalog,
			repairSessionCatalog,
			retrySessionCatalogPersistence,
			error,
			setError,
		],
	);
}

export type SessionController = ReturnType<typeof useSessions>;
