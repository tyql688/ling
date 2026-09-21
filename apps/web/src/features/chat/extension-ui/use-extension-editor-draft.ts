import { type SessionRef, sessionKey } from "@ling/contracts/session-ref";
import { onRendererSessionStateEvicted } from "@renderer/features/sessions/runtime/renderer-session-state";
import { draftsAtom, EMPTY_DRAFT } from "@renderer/features/sessions/state/drafts";
import { useSetAtom } from "jotai";
import { useEffect, useRef } from "react";

/** Apply extension editor snapshots without replacing edits the user made since the previous snapshot. */
export function useExtensionEditorDraft(ref: SessionRef | null, editorText: string | null): void {
	const setDrafts = useSetAtom(draftsAtom);
	const appliedBySession = useRef(new Map<string, string>());
	useEffect(
		() =>
			onRendererSessionStateEvicted((keys) => {
				for (const key of keys) appliedBySession.current.delete(key);
			}),
		[],
	);
	useEffect(() => {
		if (!ref || editorText === null) return;
		const key = sessionKey(ref);
		const lastApplied = appliedBySession.current.get(key) ?? null;
		if (lastApplied === editorText) return;
		setDrafts((current) => {
			const draft = current[key] ?? EMPTY_DRAFT;
			const extendsDraft = editorText.startsWith(draft.text);
			const userChangedDraft =
				lastApplied === null ? draft.text.length > 0 && !extendsDraft : draft.text !== lastApplied && !extendsDraft;
			if (userChangedDraft) return current;
			appliedBySession.current.set(key, editorText);
			return { ...current, [key]: { ...draft, text: editorText } };
		});
	}, [editorText, ref, setDrafts]);
}
