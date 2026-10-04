import { useCallback, useLayoutEffect, useRef } from "react";

/** Keeps one callback identity across a memo boundary while invoking the latest closure. Call the result from events or effects; calls during render are unsupported. */
export function useStableCallback<Args extends unknown[], Result>(
	callback: (...args: Args) => Result,
): (...args: Args) => Result {
	const latestRef = useRef(callback);
	useLayoutEffect(() => {
		latestRef.current = callback;
	});
	return useCallback((...args: Args) => latestRef.current(...args), []);
}
