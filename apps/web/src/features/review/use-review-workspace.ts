import { type SessionRef, sessionKey } from "@ling/contracts/session-ref";
import { sessionBusyFamily, sessionTranscriptStateFamily } from "@renderer/features/sessions/state/session";
import { atom, useAtomValue } from "jotai";
import { createContext, useCallback, useContext, useMemo } from "react";
import { useChangeReview } from "./use-change-review";
import { useChangedFiles } from "./use-changed-files";

export function useReviewWorkspaceOwner(ref: SessionRef | null, cwd: string | null) {
	const key = ref ? sessionKey(ref) : "";
	const busy = useAtomValue(sessionBusyFamily(key));
	const emptySeedAtom = useMemo(
		() => atom((get) => get(sessionTranscriptStateFamily(key)).knownEmptySeedPending),
		[key],
	);
	const knownEmptySeedPending = useAtomValue(emptySeedAtom);
	const review = useChangeReview(ref, knownEmptySeedPending);
	const files = useChangedFiles(cwd, busy);
	const { refresh: refreshFiles } = files;
	const { refresh: refreshReview } = review;
	const refresh = useCallback(() => {
		refreshFiles();
		void refreshReview();
	}, [refreshFiles, refreshReview]);
	return useMemo(() => ({ review, files, refresh }), [review, files, refresh]);
}
export const ReviewWorkspaceContext = createContext<ReturnType<typeof useReviewWorkspaceOwner> | null>(null);
export const ReviewWorkspaceRefreshContext = createContext<(() => void) | null>(null);

export function useReviewWorkspace() {
	const value = useContext(ReviewWorkspaceContext);
	if (!value) throw new Error("Review workspace is not mounted");
	return value;
}
