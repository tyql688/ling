import { useVirtualizer } from "@pierre/diffs/react";
import { useStableCallback } from "@renderer/hooks/use-stable-callback";
import { useEffect, useRef } from "react";

export interface DiffScrollPosition {
	top: number;
	save(top: number): void;
}

/** Pierre owns scroll geometry; the containing reading tab retains only its position. */
export function DiffScrollRestoration({ position }: { position?: DiffScrollPosition | undefined }) {
	const virtualizer = useVirtualizer();
	const initial = useRef(position?.top);
	const save = useStableCallback((top: number) => position?.save(top));
	useEffect(() => {
		if (!virtualizer || initial.current === undefined) return;
		let secondFrame = 0;
		const root = virtualizer.getRoot();
		let top = initial.current;
		const remember = () => {
			top = virtualizer.getScrollTop();
		};
		root?.addEventListener("scroll", remember);
		// The virtual file publishes its measured height in its first animation frame.
		const firstFrame = requestAnimationFrame(() => {
			secondFrame = requestAnimationFrame(() => virtualizer.scrollTo({ top: initial.current! }));
		});
		return () => {
			cancelAnimationFrame(firstFrame);
			cancelAnimationFrame(secondFrame);
			root?.removeEventListener("scroll", remember);
			save(top);
		};
	}, [virtualizer, save]);
	return null;
}
