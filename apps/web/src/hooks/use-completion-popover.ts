import type { RefObject } from "react";
import { useCallback, useEffect, useId, useRef, useState } from "react";

/**
 * Shared completion-popover controller: active-row state, wrap-around keyboard navigation,
 * and caret placement after an insertion. Both composers (session and quick-start) go through
 * it so the popover keymap and focus handling cannot diverge.
 */
export function useCompletionPopover(
	editorRef: RefObject<{ focus(offset?: number): void } | null>,
	text: string,
	cursorOffset: number,
) {
	const listId = useId();
	const [focused, setFocused] = useState(false);
	const [dismissed, setDismissed] = useState<{ text: string; cursorOffset: number } | null>(null);
	const available = focused && !(dismissed?.text === text && dismissed.cursorOffset === cursorOffset);
	const [activeIndex, setActiveIndex] = useState(0);
	const selectionFrameRef = useRef<number | null>(null);
	const focusEditorAt = useCallback(
		(offset: number): void => {
			if (selectionFrameRef.current !== null) window.cancelAnimationFrame(selectionFrameRef.current);
			selectionFrameRef.current = window.requestAnimationFrame(() => {
				selectionFrameRef.current = null;
				editorRef.current?.focus(offset);
			});
		},
		[editorRef],
	);
	useEffect(
		() => () => {
			if (selectionFrameRef.current !== null) window.cancelAnimationFrame(selectionFrameRef.current);
			selectionFrameRef.current = null;
		},
		[],
	);
	const resetActiveIndex = useCallback(() => {
		setActiveIndex(0);
		setDismissed(null);
	}, []);
	/** Active row clamped to the current item count (the list can shrink between render and keypress). */
	const activeIndexFor = (itemCount: number): number => activeIndex % Math.max(itemCount, 1);
	/**
	 * Arrow/Tab/Enter handling while the popover is visible; returns true when the event was
	 * consumed. Only a BARE Enter/Tab confirms a selection — Shift+Enter (newline) and a
	 * shortcut-modifier Enter (steer/queue while the agent runs) must fall through to the
	 * composer's Enter handler, otherwise the popover swallows them.
	 */
	const interceptPopoverKey = (
		event: globalThis.KeyboardEvent,
		itemCount: number,
		onSelect: (index: number) => void,
		open: boolean,
		onRetry?: () => void,
	): boolean => {
		if (!open || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return false;
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			setDismissed({ text, cursorOffset });
			return true;
		}
		if (itemCount === 0) {
			if (onRetry && event.key === "Enter" && !event.shiftKey) {
				event.preventDefault();
				onRetry();
				return true;
			}
			return false;
		}
		if (event.key === "ArrowDown" && !event.shiftKey) {
			event.preventDefault();
			setActiveIndex((index) => (index + 1) % itemCount);
			return true;
		}
		if (event.key === "ArrowUp" && !event.shiftKey) {
			event.preventDefault();
			setActiveIndex((index) => (index - 1 + itemCount) % itemCount);
			return true;
		}
		if ((event.key === "Tab" || event.key === "Enter") && !event.shiftKey) {
			event.preventDefault();
			onSelect(activeIndex % itemCount);
			return true;
		}
		return false;
	};
	return {
		listId,
		available,
		onFocus: () => {
			setFocused(true);
			setDismissed(null);
		},
		onBlur: () => setFocused(false),
		setActiveIndex,
		activeIndexFor,
		resetActiveIndex,
		interceptPopoverKey,
		focusEditorAt,
	};
}
