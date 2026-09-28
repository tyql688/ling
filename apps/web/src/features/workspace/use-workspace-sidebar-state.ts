import { useMemo } from "react";
import { atom, useAtom } from "jotai";
import {
	RENDERER_PREFERENCE_KEYS,
	readRendererPreference,
	writeRendererPreference,
} from "@renderer/lib/preferences/renderer-preferences";

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

const baseSidebarViewAtom = atom<WorkspaceSidebarView>(
	readRendererPreference<WorkspaceSidebarView>(RENDERER_PREFERENCE_KEYS.sidebarView, "recent", (raw) =>
		raw === "recent" || raw === "all" ? raw : null,
	).value,
);
/** Owned by WorkspaceShell so switching docked/sheet presentation never resets the sidebar view. */
const sidebarViewAtom = atom(
	(get) => get(baseSidebarViewAtom),
	(_get, set, view: WorkspaceSidebarView) => {
		set(baseSidebarViewAtom, view);
		writeRendererPreference(RENDERER_PREFERENCE_KEYS.sidebarView, view);
	},
);
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
