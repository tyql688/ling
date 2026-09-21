import { useCallback, useEffect, useRef } from "react";

/**
 * Coalesce streaming alignment to one read/write per display frame. A separate multi-frame
 * throttle makes the visible end of a thinking line jump even when its text reveals smoothly.
 */
export function useThrottledVisualUpdate(update: () => void): () => void {
	const updateRef = useRef(update);
	updateRef.current = update;
	const pendingFrameRef = useRef(0);

	useEffect(
		() => () => {
			if (pendingFrameRef.current !== 0) cancelAnimationFrame(pendingFrameRef.current);
		},
		[],
	);

	return useCallback(() => {
		if (pendingFrameRef.current !== 0) return;
		pendingFrameRef.current = requestAnimationFrame(() => {
			pendingFrameRef.current = 0;
			updateRef.current();
		});
	}, []);
}
