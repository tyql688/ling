import { useAtom, useStore } from "jotai";
import { type Dispatch, type SetStateAction, useCallback, useMemo } from "react";
import { createSessionDraftAtom, EMPTY_DRAFT, isEmptySessionDraft, type SessionDraft } from "./drafts";

/** Reads, edits and restores one session's draft through the existing bounded draft store. */
export function useSessionDraft(key: string) {
	const draftAtom = useMemo(() => createSessionDraftAtom(key), [key]);
	const [draft, setDraft] = useAtom(draftAtom);
	const store = useStore();
	const setters = useMemo(() => {
		function field<Key extends keyof SessionDraft>(key: Key): Dispatch<SetStateAction<SessionDraft[Key]>> {
			return (update) =>
				setDraft((current) => ({
					...current,
					[key]: typeof update === "function" ? update(current[key]) : update,
				}));
		}
		return {
			setText: field("text"),
			setAttachments: field("attachments"),
			setFileReferences: field("fileReferences"),
			setPastedBlocks: field("pastedBlocks"),
			setReviewComments: field("reviewComments"),
		};
	}, [setDraft]);

	const snapshot = useCallback((): SessionDraft => {
		const current = store.get(draftAtom);
		return {
			text: current.text,
			contextPositions: current.contextPositions ? [...current.contextPositions] : [],
			attachments: [...current.attachments],
			fileReferences: [...current.fileReferences],
			pastedBlocks: [...current.pastedBlocks],
			reviewComments: [...current.reviewComments],
		};
	}, [store, draftAtom]);
	const clear = useCallback(() => setDraft(EMPTY_DRAFT), [setDraft]);
	const restore = useCallback(
		(saved: SessionDraft) => {
			// The captured atom still addresses the submitting session after navigation.
			// New text or any new chip takes precedence over a failed submission's snapshot.
			setDraft((current) => (isEmptySessionDraft(current) ? saved : current));
		},
		[setDraft],
	);

	return useMemo(
		() => ({ draft, setDraft, ...setters, snapshot, clear, restore }),
		[draft, setDraft, setters, snapshot, clear, restore],
	);
}
