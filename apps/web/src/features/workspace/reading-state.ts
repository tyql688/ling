import type { FeaturePageId } from "@renderer/components/workbench/feature-navigation";
import type { SessionRef } from "@ling/contracts/session-ref";
import { sessionKey } from "@ling/contracts/session-ref";
import type { SkillInfo } from "@ling/contracts/skill";
import type { SkillReadingState } from "@renderer/features/skills/skill-reading-view";
import {
	INITIAL_WORKBENCH_PANEL_STATE,
	type WorkbenchPanelState,
} from "@renderer/components/workbench/use-workbench-panel";
import { dirtyFileDocumentsAtom, fileDocumentKey } from "@renderer/features/files/file-document-state";
import {
	EMPTY_EXPLORER_NAVIGATION,
	type WorkspaceExplorerNavigation,
} from "@renderer/features/files/use-workspace-explorer";
import type { FileReadingView } from "@renderer/features/files/use-file-preview-pane";
import type { ChangeReviewTarget } from "@renderer/features/review/change-review-target";
import { atom, useAtom } from "jotai";
import { useMemo } from "react";
import { moveTab, tabAfterClosing } from "./tab-state";

export type WorkspaceViewerTab =
	| { kind: "feature"; key: string; id: FeaturePageId }
	| { kind: "skill"; key: string; skill: SkillInfo; view?: SkillReadingState }
	| { kind: "file"; key: string; path: string; cwd: string; view?: FileReadingView }
	| ({ kind: "review"; key: string; ref: SessionRef; scrollTop?: number } & ChangeReviewTarget);

interface ReadingWorkspace {
	tabs: readonly WorkspaceViewerTab[];
	activeKey: string | null;
	previewKey: string | null;
	expanded: boolean;
	historyExpanded: boolean;
	terminalOpen: boolean;
	panel: WorkbenchPanelState;
	explorer: WorkspaceExplorerNavigation;
}

const EMPTY_READING_WORKSPACE: ReadingWorkspace = {
	tabs: [],
	activeKey: null,
	previewKey: null,
	expanded: false,
	historyExpanded: false,
	terminalOpen: false,
	panel: INITIAL_WORKBENCH_PANEL_STATE,
	explorer: EMPTY_EXPLORER_NAVIGATION,
};

/** Forty lightweight session worksets, with forty tabs each, bound navigation retention. Dirty files are exempt. */
export const READING_WORKSPACE_LIMIT = 40;
export const VIEWER_TAB_LIMIT = 40;
export const sessionWorkbenchesAtom = atom<ReadonlyMap<string, { ref: SessionRef | null; state: ReadingWorkspace }>>(
	new Map(),
);

function workbenchKey(ref: SessionRef | null): string {
	return ref === null ? "home" : sessionKey(ref);
}

export function readingWorkspaceFor(
	workspaces: ReadonlyMap<string, { state: ReadingWorkspace }>,
	ref: SessionRef | null,
): ReadingWorkspace {
	// A session that has never opened reading content starts with an empty local workset.
	return workspaces.get(workbenchKey(ref))?.state ?? EMPTY_READING_WORKSPACE;
}

function hasDirtyFile(state: ReadingWorkspace, dirty: ReadonlySet<string>): boolean {
	return state.tabs.some((tab) => tab.kind === "file" && dirty.has(fileDocumentKey(tab.cwd, tab.path)));
}

export const updateReadingWorkspaceAtom = atom(
	null,
	(
		get,
		set,
		{
			ref,
			update,
			existingOnly = false,
		}: {
			ref: SessionRef | null;
			update: (state: ReadingWorkspace) => ReadingWorkspace;
			/** Late view callbacks cannot resurrect a workspace removed with its project/session. */
			existingOnly?: boolean;
		},
	) => {
		const key = workbenchKey(ref);
		const all = get(sessionWorkbenchesAtom);
		if (existingOnly && !all.has(key)) return;
		const previous = readingWorkspaceFor(all, ref);
		const state = update(previous);
		if (state === previous) return;
		const next = new Map(all);
		next.delete(key);
		next.set(key, { ref, state });
		const dirty = get(dirtyFileDocumentsAtom);
		for (const [candidate, value] of next) {
			if (next.size <= READING_WORKSPACE_LIMIT) break;
			if (candidate !== key && !hasDirtyFile(value.state, dirty)) next.delete(candidate);
		}
		set(sessionWorkbenchesAtom, next);
	},
);

export function useReadingWorkspace(ref: SessionRef | null) {
	const stateAtom = useMemo(
		() =>
			atom(
				(get) => readingWorkspaceFor(get(sessionWorkbenchesAtom), ref),
				(_get, set, update: ReadingWorkspace | ((state: ReadingWorkspace) => ReadingWorkspace)) =>
					set(updateReadingWorkspaceAtom, {
						ref,
						existingOnly: true,
						update: (current) => (typeof update === "function" ? update(current) : update),
					}),
			),
		[ref],
	);
	return useAtom(stateAtom);
}

export const openReadingTabAtom = atom(
	null,
	(get, set, { ref, tab, keepOpen = false }: { ref: SessionRef; tab: WorkspaceViewerTab; keepOpen?: boolean }) => {
		const dirty = get(dirtyFileDocumentsAtom);
		set(updateReadingWorkspaceAtom, {
			ref,
			update: (current) => {
				const existing = current.tabs.some((item) => item.key === tab.key);
				if (existing)
					return {
						...current,
						panel: { ...current.panel, open: true },
						activeKey: tab.key,
						previewKey: keepOpen && current.previewKey === tab.key ? null : current.previewKey,
					};
				const replacing = current.tabs.find((item) => item.key === current.previewKey);
				const replace =
					replacing !== undefined &&
					!(replacing.kind === "file" && dirty.has(fileDocumentKey(replacing.cwd, replacing.path)));
				const tabs = replace
					? current.tabs.map((item) => (item.key === replacing.key ? tab : item))
					: [...current.tabs, tab];
				while (tabs.length > VIEWER_TAB_LIMIT) {
					const index = tabs.findIndex(
						(item) =>
							item.key !== tab.key && !(item.kind === "file" && dirty.has(fileDocumentKey(item.cwd, item.path))),
					);
					if (index < 0) break;
					tabs.splice(index, 1);
				}
				return {
					...current,
					panel: { ...current.panel, open: true },
					tabs,
					activeKey: tab.key,
					previewKey: keepOpen ? null : tab.key,
				};
			},
		});
	},
);

export const closeReadingTabsAtom = atom(
	null,
	(_get, set, { ref, keys }: { ref: SessionRef; keys: readonly string[] }) => {
		const closing = new Set(keys);
		set(updateReadingWorkspaceAtom, {
			ref,
			existingOnly: true,
			update: (current) => ({
				...current,
				tabs: current.tabs.filter((tab) => !closing.has(tab.key)),
				panel: {
					...current.panel,
					open:
						current.panel.open &&
						(current.panel.sideMode !== null || current.tabs.some((tab) => !closing.has(tab.key))),
				},
				activeKey: tabAfterClosing(current.tabs, current.activeKey, closing),
				previewKey: current.previewKey !== null && closing.has(current.previewKey) ? null : current.previewKey,
			}),
		});
	},
);

export const keepReadingTabOpenAtom = atom(null, (_get, set, { ref, key }: { ref: SessionRef; key: string }) => {
	set(updateReadingWorkspaceAtom, {
		ref,
		existingOnly: true,
		update: (current) => (current.previewKey === key ? { ...current, previewKey: null } : current),
	});
});

export const reorderReadingTabAtom = atom(
	null,
	(
		_get,
		set,
		{ ref, key, target, edge }: { ref: SessionRef; key: string; target: string; edge: "before" | "after" },
	) => {
		set(updateReadingWorkspaceAtom, {
			ref,
			existingOnly: true,
			update: (current) => {
				const order = moveTab(
					current.tabs.map((tab) => tab.key),
					key,
					target,
					edge,
				);
				const byKey = new Map(current.tabs.map((tab) => [tab.key, tab]));
				return {
					...current,
					tabs: order.map((item) => byKey.get(item)!),
					previewKey: current.previewKey === key ? null : current.previewKey,
				};
			},
		});
	},
);
