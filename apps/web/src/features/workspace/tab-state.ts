import { atom } from "jotai";
import type { SessionRef } from "@ling/contracts/session-ref";
import { sameSessionRef, sessionKey } from "@ling/contracts/session-ref";
import { userStateFieldAtom } from "@renderer/lib/user-state/state";
import { OPEN_SESSION_TABS_MAX_ITEMS } from "@ling/contracts/user-state";

/** Permanent conversation tabs are shared; each window owns its conversation preview. */
export const openSessionTabsAtom = userStateFieldAtom("openSessionTabs", (before, after) => {
	after = after.slice(-OPEN_SESSION_TABS_MAX_ITEMS);
	const previous = new Set(before.map(sessionKey)),
		next = new Set(after.map(sessionKey));
	return [
		{
			type: "tabs",
			add: after.filter((ref) => !previous.has(sessionKey(ref))),
			remove: before.filter((ref) => !next.has(sessionKey(ref))),
			order: after,
		},
	];
});

export const sessionPreviewAtom = atom<SessionRef | null>(null);
export const sessionTabOrderAtom = atom<string[]>([]);
type WorkspaceTabGroup = "conversation" | "reading";
export const focusedTabGroupAtom = atom<WorkspaceTabGroup>("conversation");

export const replaceSessionPreviewAtom = atom(null, (get, set, ref: SessionRef) => {
	const previous = get(sessionPreviewAtom);
	if (sameSessionRef(previous, ref)) return;
	const key = sessionKey(ref);
	set(sessionTabOrderAtom, (keys) => {
		const oldKey = previous === null ? null : sessionKey(previous);
		return oldKey !== null && keys.includes(oldKey)
			? keys.map((item) => (item === oldKey ? key : item))
			: [...keys.filter((item) => item !== key), key];
	});
	set(sessionPreviewAtom, ref);
});

export const keepSessionTabOpenAtom = atom(null, (get, set, ref: SessionRef) => {
	set(openSessionTabsAtom, (tabs) =>
		tabs.some((tab) => sameSessionRef(tab, ref)) ? tabs : orderSessionTabs([...tabs, ref], get(sessionTabOrderAtom)),
	);
	if (sameSessionRef(get(sessionPreviewAtom), ref)) set(sessionPreviewAtom, null);
});

/** Closing an item chooses a neighbor in the same group and never crosses into another group. */
export function tabAfterClosing(
	tabs: readonly { key: string }[],
	activeKey: string | null,
	closing: ReadonlySet<string>,
): string | null {
	if (activeKey === null || !closing.has(activeKey)) return activeKey;
	const index = tabs.findIndex((tab) => tab.key === activeKey);
	const remaining = tabs.filter((tab) => !closing.has(tab.key));
	return remaining[Math.min(Math.max(index, 0), remaining.length - 1)]?.key ?? null;
}

/** Retain existing positions, remove closed entries, and append newly opened tabs. */
export function reconcileTabOrder(order: readonly string[], available: readonly string[]): string[] {
	const existing = new Set(available);
	const result = order.filter((key) => existing.delete(key));
	return [...result, ...existing];
}

export function moveTab(order: readonly string[], key: string, target: string, edge: "before" | "after"): string[] {
	if (key === target || !order.includes(key) || !order.includes(target)) return [...order];
	const next = order.filter((item) => item !== key);
	next.splice(next.indexOf(target) + (edge === "after" ? 1 : 0), 0, key);
	return next;
}

export function orderSessionTabs(refs: readonly SessionRef[], order: readonly string[]): SessionRef[] {
	const positions = new Map(order.map((key, index) => [key, index]));
	return [...refs].sort(
		(a, b) => (positions.get(sessionKey(a)) ?? order.length) - (positions.get(sessionKey(b)) ?? order.length),
	);
}
