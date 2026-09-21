import { useMemo } from "react";
import { atom, useAtom } from "jotai";

/** Archived section initial row count; keep the sidebar compact, expand on demand via "more". */
const ARCHIVED_INITIAL_COUNT = 10;

type WorkspaceSidebarView = "recent" | "all";

export interface WorkspaceSidebarState {
	view: WorkspaceSidebarView;
	setView: (view: WorkspaceSidebarView) => void;
	archivedExpanded: boolean;
	setArchivedExpanded: (expanded: boolean | ((current: boolean) => boolean)) => void;
	archivedVisibleCount: number;
	setArchivedVisibleCount: (count: number | ((current: number) => number)) => void;
}

/** Owned by WorkspaceShell so switching docked/sheet presentation never resets the sidebar view. */
const sidebarViewAtom = atom<WorkspaceSidebarView>("recent");
const archivedExpandedAtom = atom(false);
const archivedVisibleCountAtom = atom(ARCHIVED_INITIAL_COUNT);

export function useWorkspaceSidebarState(): WorkspaceSidebarState {
	const [view, setView] = useAtom(sidebarViewAtom);
	const [archivedExpanded, setArchivedExpanded] = useAtom(archivedExpandedAtom);
	const [archivedVisibleCount, setArchivedVisibleCount] = useAtom(archivedVisibleCountAtom);
	return useMemo(
		() => ({
			view,
			setView,
			archivedExpanded,
			setArchivedExpanded,
			archivedVisibleCount,
			setArchivedVisibleCount,
		}),
		[view, setView, archivedExpanded, setArchivedExpanded, archivedVisibleCount, setArchivedVisibleCount],
	);
}
