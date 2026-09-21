import { useCallback, useLayoutEffect, useRef } from "react";
import type { GroupProps, PanelImperativeHandle } from "react-resizable-panels";

/** Commit measured pixels after the library's layout callback has reached the DOM. */
export function usePanelSizeCommit(panel: PanelImperativeHandle | null, onCommit: (pixels: number) => void) {
	const frame = useRef<number | null>(null);
	const commit = useRef(onCommit);
	useLayoutEffect(() => {
		commit.current = onCommit;
	});
	const cancel = useCallback(() => {
		if (frame.current !== null) cancelAnimationFrame(frame.current);
		frame.current = null;
	}, []);
	useLayoutEffect(() => cancel, [cancel, panel]);
	const schedule = useCallback(() => {
		cancel();
		if (!panel) return;
		frame.current = requestAnimationFrame(() => {
			frame.current = null;
			commit.current(Math.round(panel.getSize().inPixels));
		});
	}, [cancel, panel]);
	const onLayoutChanged: NonNullable<GroupProps["onLayoutChanged"]> = useCallback(
		(_layout, meta) => {
			if (meta.isUserInteraction) schedule();
		},
		[schedule],
	);
	const reset = useCallback(
		(size: number) => {
			// The library's double-click reset is an imperative resize, so it has no user-interaction metadata.
			panel?.resize(size);
			schedule();
		},
		[panel, schedule],
	);
	return { onLayoutChanged, reset };
}
