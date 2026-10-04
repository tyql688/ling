import type { RefObject } from "react";
import { useCallback, useEffect, useId, useRef, useState } from "react";

/** Tracks the active completion row, wraps keyboard navigation and places the caret after insertion for both composers. */
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
	/** Handles arrows, Tab and Enter while the popover is visible. Returns true when it consumes the event. Bare Enter or Tab confirms a selection. Shift+Enter and shortcut-modifier Enter reach the composer for newline, steer or queue handling. */
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
