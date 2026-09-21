import { type PointerEvent, type RefObject, useRef, useState } from "react";

interface TabDrop {
	key: string;
	edge: "before" | "after";
}

/** Pointer capture keeps in-window tab sorting independent of native titlebar and OS file dragging. */
export function useTabDrag(
	strip: RefObject<HTMLDivElement | null>,
	keys: readonly string[],
	onReorder: (key: string, target: string, edge: "before" | "after") => void,
) {
	const gesture = useRef<{ key: string; x: number; active: boolean; drop: TabDrop | null } | null>(null);
	const suppressClick = useRef(false);
	const [drag, setDrag] = useState<{ key: string; offset: number } | null>(null);
	const [drop, setDrop] = useState<TabDrop | null>(null);

	function finish(commit: boolean) {
		const current = gesture.current;
		gesture.current = null;
		setDrag(null);
		setDrop(null);
		if (current === null) return;
		suppressClick.current = current.active;
		if (commit && current.active && current.drop !== null) onReorder(current.key, current.drop.key, current.drop.edge);
	}
	function pointerDown(event: PointerEvent<HTMLButtonElement>, key: string) {
		if (
			event.button !== 0 ||
			event.pointerType !== "mouse" ||
			(event.target as HTMLElement).closest("[data-tab-close]")
		)
			return;
		gesture.current = { key, x: event.clientX, active: false, drop: null };
		suppressClick.current = false;
		event.currentTarget.setPointerCapture(event.pointerId);
	}
	function pointerMove(event: PointerEvent<HTMLButtonElement>) {
		const current = gesture.current;
		if (current === null || strip.current === null) return;
		const offset = event.clientX - current.x;
		// Ignore click jitter so double-click promotion never starts a drag.
		if (!current.active && Math.abs(offset) < 4) return;
		current.active = true;
		event.preventDefault();
		setDrag({ key: current.key, offset });
		const elements = strip.current.querySelectorAll<HTMLElement>('[role="tab"]');
		let target: TabDrop | null = null;
		for (const [index, element] of elements.entries()) {
			const key = keys[index];
			if (key === undefined || key === current.key) continue;
			const rect = element.getBoundingClientRect();
			if (event.clientX < rect.left + rect.width / 2) {
				target = { key, edge: "before" };
				break;
			}
			target = { key, edge: "after" };
		}
		current.drop = target;
		setDrop((previous) => (previous?.key === target?.key && previous?.edge === target?.edge ? previous : target));
	}
	return {
		drag,
		drop,
		pointerDown,
		pointerMove,
		finish,
		consumeDragClick: () => {
			const suppressed = suppressClick.current;
			suppressClick.current = false;
			return suppressed;
		},
	};
}
