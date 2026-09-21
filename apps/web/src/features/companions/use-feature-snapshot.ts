import { formatRequestError } from "@renderer/lib/errors";
import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { createFeatureSnapshot } from "./feature-snapshot";

/** Shares refresh and action ownership without retaining another session's data or callbacks. */
export function useFeatureSnapshot<Value>(options: {
	load(): Promise<Value>;
	subscribe(refresh: () => void): () => void;
	/** The feature's owner, such as a session ref. Changing it starts an empty snapshot. */
	key: string;
	/** Refresh the same owner's data without retiring an action already in progress. */
	revision?: string;
}) {
	const latest = useRef(options);
	latest.current = options;
	// eslint-disable-next-line react-hooks/exhaustive-deps -- Only an owner change retires its in-flight operations.
	const owner = useMemo(() => createFeatureSnapshot(() => latest.current.load()), [options.key]);
	const snapshot = useSyncExternalStore(owner.subscribe, owner.getSnapshot);
	useLayoutEffect(() => {
		const stop = owner.start();
		const unsubscribe = latest.current.subscribe(() => void owner.refresh());
		return () => {
			stop();
			unsubscribe();
		};
	}, [owner]);
	useEffect(() => void owner.refresh(), [owner, options.revision]);
	return {
		...snapshot,
		error: snapshot.error === null ? null : formatRequestError(snapshot.error),
		act: owner.act,
		refresh: owner.refresh,
	};
}
