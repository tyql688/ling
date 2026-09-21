import { useDomainApi } from "@renderer/lib/host-api-context";
import { type ComposerHistoryEntry, SESSION_COMPOSER_HISTORY_MAX_ITEMS } from "@ling/contracts/session";
import { formatRequestError } from "@renderer/lib/errors";
import { isShortcutModifier } from "@renderer/lib/platform";
import { useCallback, useEffect, useRef } from "react";

/** Arrow-up enters history navigation only when the cursor is on the first line (in a multi-line draft, ↑ still moves the cursor) */
export function shouldStartComposerHistoryNavigation(
	event: globalThis.KeyboardEvent,
	selection: { cursorOffset: number; selectionEnd: number } | undefined,
): boolean {
	if (event.shiftKey || isShortcutModifier(event)) return false;
	return selection?.cursorOffset === 0 && selection.selectionEnd === 0;
}

interface ComposerHistoryParams {
	draftKey: string;
	cwd: string;
	text: string;
	onCommandError: (message: string) => void;
	/** Writes history text back into the draft (cursor and completion-state reset owned by the caller) */
	applyText: (value: string) => void;
}

export function useComposerHistory({ draftKey, cwd, text, onCommandError, applyText }: ComposerHistoryParams) {
	const hostSessionApi = useDomainApi("session");

	const composerHistoryRef = useRef<ComposerHistoryEntry[]>([]);
	const composerHistoryLoadedRef = useRef(false);
	const composerHistoryCursorRef = useRef<number | null>(null);
	const composerHistoryDraftRef = useRef("");
	const composerHistoryKeyRef = useRef(draftKey);

	const resetComposerHistoryNavigation = useCallback(() => {
		composerHistoryCursorRef.current = null;
		composerHistoryDraftRef.current = "";
	}, []);

	useEffect(() => {
		if (composerHistoryKeyRef.current === draftKey) return;
		composerHistoryKeyRef.current = draftKey;
		composerHistoryRef.current = [];
		composerHistoryLoadedRef.current = false;
		resetComposerHistoryNavigation();
	}, [draftKey, resetComposerHistoryNavigation]);

	const loadComposerHistory = useCallback(async () => {
		if (composerHistoryLoadedRef.current) return composerHistoryRef.current;
		const requestCwd = cwd;
		const requestDraftKey = composerHistoryKeyRef.current;
		const entries = await hostSessionApi.listComposerHistory({
			cwd: requestCwd,
		});
		// Latest-wins: ignore a late response after the composer switched project/session.
		if (composerHistoryKeyRef.current !== requestDraftKey || cwd !== requestCwd) {
			return composerHistoryRef.current;
		}
		composerHistoryRef.current = entries;
		composerHistoryLoadedRef.current = true;
		return entries;
	}, [hostSessionApi, cwd]);

	const rememberLocalComposerHistory = useCallback(
		(submitted: string) => {
			if (submitted.trim().length === 0) return;
			const entry: ComposerHistoryEntry = {
				text: submitted,
				cwd,
				createdAt: Date.now(),
			};
			composerHistoryRef.current = [
				entry,
				...composerHistoryRef.current.filter((item) => item.text !== submitted),
			].slice(0, SESSION_COMPOSER_HISTORY_MAX_ITEMS);
			composerHistoryLoadedRef.current = true;
		},
		[cwd],
	);

	const navigateComposerHistory = useCallback(
		(direction: "previous" | "next") => {
			void (async () => {
				const entries = await loadComposerHistory();
				if (entries.length === 0) return;
				const currentCursor = composerHistoryCursorRef.current;
				if (direction === "previous") {
					if (currentCursor === null) composerHistoryDraftRef.current = text;
					const nextCursor = currentCursor === null ? 0 : Math.min(currentCursor + 1, entries.length - 1);
					composerHistoryCursorRef.current = nextCursor;
					applyText(entries[nextCursor]?.text ?? composerHistoryDraftRef.current);
					return;
				}
				if (currentCursor === null) return;
				const nextCursor = currentCursor - 1;
				if (nextCursor < 0) {
					composerHistoryCursorRef.current = null;
					applyText(composerHistoryDraftRef.current);
					return;
				}
				composerHistoryCursorRef.current = nextCursor;
				applyText(entries[nextCursor]?.text ?? composerHistoryDraftRef.current);
			})().catch((cause: unknown) => onCommandError(formatRequestError(cause)));
		},
		[loadComposerHistory, onCommandError, applyText, text],
	);

	const isNavigatingHistory = useCallback(() => composerHistoryCursorRef.current !== null, []);

	return { isNavigatingHistory, navigateComposerHistory, rememberLocalComposerHistory, resetComposerHistoryNavigation };
}
