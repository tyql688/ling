import { useCallback, useEffect, useRef, useState } from "react";

/** Keep the copy-success check visible for two seconds. */
export const COPY_FEEDBACK_MS = 2_000;

/** Rotates the check icon into view when it replaces the copy icon. */
export const COPY_CHECK_CLASS = "animate-in zoom-in-50 spin-in-45 duration-200 motion-reduce:animate-none";

export function useCopyFeedback<Key>() {
	const [copiedKey, setCopiedKey] = useState<Key | null>(null);
	const confirmationId = useRef(0);
	const clearTimerRef = useRef<number | null>(null);
	const cancelClearTimer = useCallback(() => {
		if (clearTimerRef.current === null) return;
		window.clearTimeout(clearTimerRef.current);
		clearTimerRef.current = null;
	}, []);
	const markCopied = useCallback(
		(key: Key) => {
			cancelClearTimer();
			const id = ++confirmationId.current;
			setCopiedKey(key);
			clearTimerRef.current = window.setTimeout(() => {
				clearTimerRef.current = null;
				if (confirmationId.current === id) setCopiedKey(null);
			}, COPY_FEEDBACK_MS);
		},
		[cancelClearTimer],
	);
	const clearCopied = useCallback(() => {
		confirmationId.current += 1;
		cancelClearTimer();
		setCopiedKey(null);
	}, [cancelClearTimer]);
	useEffect(() => cancelClearTimer, [cancelClearTimer]);
	return { copiedKey, markCopied, clearCopied };
}
