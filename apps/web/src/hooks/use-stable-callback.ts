import { useCallback, useLayoutEffect, useRef } from "react";

/** For callbacks crossing a memo boundary: the memoized child keeps one function identity
 * while invocations always reach the latest closure — stale-capture safe without making
 * the callback a comparator input. Never call the result during render. */
export function useStableCallback<Args extends unknown[], Result>(
	callback: (...args: Args) => Result,
): (...args: Args) => Result {
	const latestRef = useRef(callback);
	useLayoutEffect(() => {
		latestRef.current = callback;
	});
	return useCallback((...args: Args) => latestRef.current(...args), []);
}
