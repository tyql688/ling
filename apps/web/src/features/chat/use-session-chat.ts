import { useDomainApi } from "@renderer/lib/host-api-context";
import {
	type ImageAttachment,
	type SendMode,
	type SessionRef,
	EMPTY_EXTENSION_UI_STATE,
} from "@ling/contracts/session";
import type { MessageFileReference } from "@ling/contracts/file-reference-text";
import { sessionKey } from "@ling/contracts/session-ref";
import { setRendererSessionError } from "@renderer/features/sessions/runtime/renderer-session-state";
import { useSessionProjectionRefresh } from "@renderer/features/sessions/runtime/session-projection-context";
import { archivedTranscriptsAtom } from "@renderer/features/sessions/archived-session-state";
import { draftsAtom, EMPTY_DRAFT } from "@renderer/features/sessions/state/drafts";
import { submitMessageText } from "@renderer/features/sessions/state/message-text";
import {
	extensionUiSnapshotFamily,
	sessionBusyFamily,
	sessionErrorMessageFamily,
	sessionMessagesFamily,
	sessionQueueFamily,
	sessionSummarizationRetryFamily,
	sessionTranscriptStateFamily,
} from "@renderer/features/sessions/state/session";
import { formatRequestError } from "@renderer/lib/errors";
import { useAtom, useAtomValue, useStore } from "jotai";
import { useCallback, useEffect, useMemo } from "react";
import { synchronizeExtensionViewport } from "./extension-ui/extension-ui-viewport";
import { useTranscriptHistory } from "./transcript/use-transcript-history";

export function useSessionChat(ref: SessionRef | null) {
	const hostSessionApi = useDomainApi("session");

	const refreshSessionProjection = useSessionProjectionRefresh();
	const key = ref ? sessionKey(ref) : "";
	const [messages] = useAtom(sessionMessagesFamily(key));
	const [busy] = useAtom(sessionBusyFamily(key));
	const [queue] = useAtom(sessionQueueFamily(key));
	const [summarizationRetry] = useAtom(sessionSummarizationRetryFamily(key));
	const [transcriptState] = useAtom(sessionTranscriptStateFamily(key));
	const archivedTranscripts = useAtomValue(archivedTranscriptsAtom);
	const [extensionUiSnapshot] = useAtom(extensionUiSnapshotFamily(key));
	const [error] = useAtom(sessionErrorMessageFamily(key));
	const extensionUiState = extensionUiSnapshot?.state ?? EMPTY_EXTENSION_UI_STATE;
	const store = useStore();

	/** Banner text + sidebar "Failed" share one write path so IPC/send failures are not silent in the list. */
	const reportError = useCallback(
		(message: string | null) => {
			if (!key) return;
			setRendererSessionError(store, key, message);
		},
		[key, store],
	);

	/** Projection refresh is best-effort everywhere it is called; a failure is reported, never thrown. */
	const safeRefresh = useCallback(
		(target: SessionRef) => {
			try {
				refreshSessionProjection(target);
			} catch (cause: unknown) {
				reportError(formatRequestError(cause));
			}
		},
		[reportError, refreshSessionProjection],
	);

	// Resume keeps complete cached rows mounted but clears their retired runtime binding. Report
	// the real transcript width before asking Pi to project: otherwise a markdown transformer
	// renders the entire branch once at its fallback width and again after the viewport event.
	useEffect(() => {
		// An archived session is read from its file and never binds a runtime, so there is nothing
		// to report a viewport to.
		if (!ref || transcriptState.runtimeId !== null || archivedTranscripts.has(sessionKey(ref))) return;
		let cancelled = false;
		void synchronizeExtensionViewport(hostSessionApi, ref)
			.catch((cause: unknown) => {
				if (!cancelled) reportError(formatRequestError(cause));
			})
			.finally(() => {
				// Viewport synchronization failure is reported, but it must not strand the
				// authoritative transcript snapshot behind a renderer measurement problem.
				if (!cancelled) safeRefresh(ref);
			});
		return () => {
			cancelled = true;
		};
	}, [archivedTranscripts, hostSessionApi, ref, reportError, safeRefresh, transcriptState.runtimeId]);

	useEffect(() => {
		if (!ref || !busy) return;
		const refreshIfVisible = () => {
			if (document.visibilityState === "visible") {
				safeRefresh(ref);
			}
		};
		const refreshAfterNetworkRestore = () => {
			safeRefresh(ref);
		};
		document.addEventListener("visibilitychange", refreshIfVisible);
		window.addEventListener("online", refreshAfterNetworkRestore);
		return () => {
			document.removeEventListener("visibilitychange", refreshIfVisible);
			window.removeEventListener("online", refreshAfterNetworkRestore);
		};
	}, [ref, busy, safeRefresh]);

	const historyLoad = useTranscriptHistory(ref, transcriptState, safeRefresh);

	const send = useCallback(
		async (
			text: string,
			mode: SendMode = "prompt",
			images?: ImageAttachment[],
			fileReferences?: MessageFileReference[],
		) => {
			const submitted = submitMessageText(text);
			if (!ref || (submitted === null && !images?.length)) return;
			try {
				await hostSessionApi.sendMessage({ ref, text: submitted ?? "", mode, images, fileReferences });
				reportError(null);
			} catch (cause) {
				reportError(formatRequestError(cause));
				throw cause;
			}
		},
		[hostSessionApi, ref, reportError],
	);

	const abort = useCallback(async () => {
		if (!ref) return;
		try {
			const { restoredTexts } = await hostSessionApi.abort(ref);
			if (restoredTexts.length > 0) {
				const sessionKeyValue = sessionKey(ref);
				store.set(draftsAtom, (drafts) => {
					const current = drafts[sessionKeyValue] ?? EMPTY_DRAFT;
					const restored = restoredTexts.join("\n\n");
					return {
						...drafts,
						[sessionKeyValue]: {
							...current,
							text: current.text === "" ? restored : `${current.text}\n\n${restored}`,
						},
					};
				});
			}
			reportError(null);
		} catch (cause) {
			reportError(formatRequestError(cause));
		}
	}, [hostSessionApi, ref, reportError, store]);

	// Show the retained transcript when the initial history attempt settles, including partial
	// progress after failure. Aggregate usage and the minimap still require complete history.
	const transcriptReady = Boolean(ref) && transcriptState.hydrationSettled;
	const transcriptHistoryReady = Boolean(ref) && transcriptState.hydrationSettled && !transcriptState.hasOlder;

	return useMemo(
		() => ({
			messages,
			busy,
			summarizationRetry,
			queue,
			extensionUiState,
			error,
			transcriptReady,
			transcriptHistoryReady,
			historyLoad,
			knownEmptyTimelineSeedPending: transcriptState.knownEmptySeedPending,
			send,
			abort,
		}),
		[
			messages,
			busy,
			summarizationRetry,
			queue,
			extensionUiState,
			error,
			transcriptReady,
			transcriptHistoryReady,
			historyLoad,
			transcriptState.knownEmptySeedPending,
			send,
			abort,
		],
	);
}
