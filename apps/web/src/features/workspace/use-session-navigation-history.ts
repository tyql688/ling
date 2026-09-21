import type { SessionSummary } from "@ling/contracts/session";
import type { SessionRef } from "@ling/contracts/session-ref";
import { sessionKey, toSessionRef } from "@ling/contracts/session-ref";
import { useCallback, useEffect, useMemo, useState } from "react";

const MAX_HISTORY_ENTRIES = 50;

interface SessionNavigationState {
	entries: SessionRef[];
	index: number;
	pendingKey: string | null;
	previousIndex: number | null;
}

interface SessionNavigationHistory {
	canGoBack: boolean;
	canGoForward: boolean;
	goBack: () => void;
	goForward: () => void;
}

interface UseSessionNavigationHistoryOptions {
	sessions: readonly SessionSummary[];
	activeSessionRef: SessionRef | null;
	onSelect: (ref: SessionRef) => Promise<void>;
	onError: (error: unknown) => void;
}

const INITIAL_STATE: SessionNavigationState = {
	entries: [],
	index: -1,
	pendingKey: null,
	previousIndex: null,
};

function findAvailableIndex(
	entries: readonly SessionRef[],
	startIndex: number,
	direction: -1 | 1,
	availableKeys: ReadonlySet<string>,
): number {
	for (let index = startIndex + direction; index >= 0 && index < entries.length; index += direction) {
		const entry = entries[index];
		if (entry && availableKeys.has(sessionKey(entry))) return index;
	}
	return -1;
}

export function useSessionNavigationHistory({
	sessions,
	activeSessionRef,
	onSelect,
	onError,
}: UseSessionNavigationHistoryOptions): SessionNavigationHistory {
	const [state, setState] = useState<SessionNavigationState>(INITIAL_STATE);
	const availableKeys = useMemo(
		() => new Set(sessions.map((session) => sessionKey(toSessionRef(session)))),
		[sessions],
	);

	useEffect(() => {
		if (activeSessionRef === null) return;
		const activeKey = sessionKey(activeSessionRef);
		setState((current) => {
			if (current.pendingKey === activeKey) {
				return { ...current, pendingKey: null, previousIndex: null };
			}
			const currentEntry = current.entries[current.index];
			if (currentEntry && sessionKey(currentEntry) === activeKey) return current;
			const entries = [...current.entries.slice(0, current.index + 1), activeSessionRef].slice(-MAX_HISTORY_ENTRIES);
			return {
				entries,
				index: entries.length - 1,
				pendingKey: null,
				previousIndex: null,
			};
		});
	}, [activeSessionRef]);

	const navigate = useCallback(
		(direction: -1 | 1) => {
			if (state.pendingKey !== null) return;
			const targetIndex = findAvailableIndex(state.entries, state.index, direction, availableKeys);
			if (targetIndex === -1) return;
			const target = state.entries[targetIndex];
			if (!target) return;
			const targetKey = sessionKey(target);
			const previousIndex = state.index;
			setState((current) => ({ ...current, index: targetIndex, pendingKey: targetKey, previousIndex }));
			void onSelect(target).catch((error: unknown) => {
				setState((current) =>
					current.pendingKey === targetKey
						? { ...current, index: current.previousIndex ?? previousIndex, pendingKey: null, previousIndex: null }
						: current,
				);
				onError(error);
			});
		},
		[availableKeys, onError, onSelect, state],
	);

	const goBack = useCallback<SessionNavigationHistory["goBack"]>(() => navigate(-1), [navigate]);
	const goForward = useCallback<SessionNavigationHistory["goForward"]>(() => navigate(1), [navigate]);
	return useMemo(
		() => ({
			canGoBack: state.pendingKey === null && findAvailableIndex(state.entries, state.index, -1, availableKeys) !== -1,
			canGoForward:
				state.pendingKey === null && findAvailableIndex(state.entries, state.index, 1, availableKeys) !== -1,
			goBack,
			goForward,
		}),
		[state, availableKeys, goBack, goForward],
	);
}
