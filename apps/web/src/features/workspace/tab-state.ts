import { atom } from "jotai";
type WorkspaceTabGroup = "conversation" | "reading";
export const focusedTabGroupAtom = atom<WorkspaceTabGroup>("conversation");

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

export function moveTab(order: readonly string[], key: string, target: string, edge: "before" | "after"): string[] {
	if (key === target || !order.includes(key) || !order.includes(target)) return [...order];
	const next = order.filter((item) => item !== key);
	next.splice(next.indexOf(target) + (edge === "after" ? 1 : 0), 0, key);
	return next;
}
