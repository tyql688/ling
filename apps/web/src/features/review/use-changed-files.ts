import { useDomainApi } from "@renderer/lib/host-api-context";
import type { GitChangedFile } from "@ling/contracts/git";
import { errorMessage } from "@ling/contracts/ling-error";
import { isProjectDirectoryMissing } from "@renderer/lib/errors";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * Poll interval while idle. Git status has process cost; 4s is enough for the
 * sidebar "changes" badge to track manual edits without flooding IPC when idle.
 */
const IDLE_REFRESH_MS = 4_000;
/**
 * Poll interval while the agent is busy. Tool turns touch disk continuously; 1.5s
 * keeps footer counts and the explorer tree responsive — shorter would contend with the main
 * process Git write queue.
 */
const BUSY_REFRESH_MS = 1_500;

interface ChangedFilesSnapshot {
	files: GitChangedFile[];
	error: string | null;
	refresh: () => void;
}

function sameChangedFiles(a: readonly GitChangedFile[], b: readonly GitChangedFile[]): boolean {
	if (a.length !== b.length) return false;
	return a.every((file, index) => {
		const other = b[index];
		return (
			other !== undefined &&
			file.path === other.path &&
			file.status === other.status &&
			file.from === other.from &&
			file.additions === other.additions &&
			file.deletions === other.deletions
		);
	});
}

export function useChangedFiles(cwd: string | null, busy: boolean): ChangedFilesSnapshot {
	const hostGitApi = useDomainApi("git");

	const [files, setFiles] = useState<GitChangedFile[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [directoryMissing, setDirectoryMissing] = useState(false);
	const mountedRef = useRef(true);
	const refreshRequestRef = useRef(0);
	const refreshInFlightRef = useRef<object | null>(null);
	const refreshQueuedRef = useRef(false);
	const refreshRef = useRef<() => void>(() => {});

	const refresh = useCallback(() => {
		if (!cwd) {
			refreshRequestRef.current += 1;
			refreshQueuedRef.current = false;
			setFiles([]);
			setError(null);
			return;
		}
		// Poll/focus/visibility events are invalidations, not independent reads. Keep at
		// most one IPC/Git process live and collapse any burst into one follow-up pass.
		if (refreshInFlightRef.current !== null) {
			refreshQueuedRef.current = true;
			return;
		}
		const requestId = refreshRequestRef.current + 1;
		refreshRequestRef.current = requestId;
		const token = {};
		refreshInFlightRef.current = token;
		void hostGitApi
			.getChangedFiles(cwd)
			.then((next) => {
				if (!mountedRef.current || refreshRequestRef.current !== requestId) return;
				setFiles((current) => (sameChangedFiles(current, next) ? current : next));
				setError(null);
				setDirectoryMissing(false);
			})
			.catch((refreshError: unknown) => {
				if (!mountedRef.current || refreshRequestRef.current !== requestId) return;
				setError(errorMessage(refreshError));
				// A deleted project folder cannot resolve on its own; polling it every few seconds
				// only repeats the same failure. Focus and explicit refreshes still retry.
				setDirectoryMissing(isProjectDirectoryMissing(refreshError));
			})
			.finally(() => {
				if (refreshInFlightRef.current !== token) return;
				refreshInFlightRef.current = null;
				if (!mountedRef.current || !refreshQueuedRef.current) return;
				refreshQueuedRef.current = false;
				queueMicrotask(() => refreshRef.current());
			});
	}, [hostGitApi, cwd]);
	refreshRef.current = refresh;

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
			refreshQueuedRef.current = false;
		};
	}, []);

	// Clear only when the project identity changes. A busy toggle only changes the poll interval.
	useEffect(() => {
		refreshRequestRef.current += 1;
		setFiles([]);
		setError(null);
		setDirectoryMissing(false);
		if (!cwd) return;
		refresh();
	}, [cwd, refresh]);

	useEffect(() => {
		if (!cwd) return;
		const intervalId = directoryMissing
			? undefined
			: window.setInterval(refresh, busy ? BUSY_REFRESH_MS : IDLE_REFRESH_MS);
		const handleFocus = () => refresh();
		const handleVisibilityChange = () => {
			if (document.visibilityState === "visible") refresh();
		};
		window.addEventListener("focus", handleFocus);
		document.addEventListener("visibilitychange", handleVisibilityChange);
		return () => {
			if (intervalId !== undefined) window.clearInterval(intervalId);
			window.removeEventListener("focus", handleFocus);
			document.removeEventListener("visibilitychange", handleVisibilityChange);
		};
	}, [busy, cwd, directoryMissing, refresh]);

	return useMemo(() => ({ files, error, refresh }), [files, error, refresh]);
}
