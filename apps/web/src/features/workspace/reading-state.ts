import type { ChangeReviewScope } from "@ling/contracts/git";
import type { FeaturePageId } from "@renderer/components/workbench/feature-navigation";
import type { SessionRef } from "@ling/contracts/session-ref";
import { sessionKey } from "@ling/contracts/session-ref";
import type { ProjectSkillSelection } from "@renderer/features/skills/project-skills-panel";
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
	| { kind: "file"; key: string; path: string; cwd: string; view?: FileReadingView }
	| ({ kind: "review"; key: string; ref: SessionRef; scrollTop?: number } & ChangeReviewTarget);

export type WorkbenchReviewScope = Extract<ChangeReviewScope, "turn" | "session" | "workspace" | "unpushed">;

export interface WorkbenchPanelState {
	/** Right column visibility. An open column always has a tab; closing it keeps the tabs for restoration. */
	open: boolean;
	/** The file tree docked beside the right column's content. */
	treeOpen: boolean;
	/** Branch history opens from the Changes tab and does not replace it. */
	historyOpen: boolean;
	/** File focus: expand parent directories and select the preview; directory focus: only expand that directory, no file preview. */
	explorerFocus: { path: string; directory: boolean } | null;
	reviewScope: WorkbenchReviewScope;
	reviewTurnId: string | null;
	reviewFocusFile: string | null;
}

/** The right column starts closed; its first open lands on the new tab page. */
export const INITIAL_WORKBENCH_PANEL_STATE: WorkbenchPanelState = {
	open: false,
	treeOpen: false,
	historyOpen: false,
	explorerFocus: null,
	reviewScope: "session",
	reviewTurnId: null,
	reviewFocusFile: null,
};

export interface ReadingWorkspace {
	tabs: readonly WorkspaceViewerTab[];
	activeKey: string | null;
	expanded: boolean;
	historyExpanded: boolean;
	panel: WorkbenchPanelState;
	explorer: WorkspaceExplorerNavigation;
	skill: ProjectSkillSelection | null;
}

const EMPTY_READING_WORKSPACE: ReadingWorkspace = {
	tabs: [],
	activeKey: null,
	expanded: false,
	historyExpanded: false,
	panel: INITIAL_WORKBENCH_PANEL_STATE,
	explorer: EMPTY_EXPLORER_NAVIGATION,
	skill: null,
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

export function featureTabKey(id: FeaturePageId): string {
	return `feature:${id}`;
}

/** Opening content consumes the active launcher; existing content keeps its view state and position. */
function withOpenedTab(state: ReadingWorkspace, tab: WorkspaceViewerTab): ReadingWorkspace {
	const active = state.tabs.find((item) => item.key === state.activeKey);
	const replace =
		active?.kind === "feature" &&
		((active.id === "new-tab" && !(tab.kind === "feature" && tab.id === "new-tab")) ||
			(active.id === "files" && tab.kind === "file"));
	const existing = state.tabs.some((item) => item.key === tab.key);
	const tabs = existing
		? replace && active.key !== tab.key
			? state.tabs.filter((item) => item.key !== active.key)
			: state.tabs
		: replace
			? state.tabs.map((item) => (item.key === active.key ? tab : item))
			: [...state.tabs, tab];
	return { ...state, panel: { ...state.panel, open: true }, tabs, activeKey: tab.key };
}

/** Every new-tab action creates a launcher; tools have one retained tab per session. */
export function withFeatureTab(state: ReadingWorkspace, id: FeaturePageId): ReadingWorkspace {
	const key = id === "new-tab" ? `${featureTabKey(id)}:${crypto.randomUUID()}` : featureTabKey(id);
	return withOpenedTab(state, { kind: "feature", key, id });
}

/** Opens the right column; an empty column lands on the new tab page. */
export function withOpenColumn(state: ReadingWorkspace): ReadingWorkspace {
	return state.tabs.length === 0
		? withFeatureTab(state, "new-tab")
		: { ...state, panel: { ...state.panel, open: true } };
}

/** Closing the last tab closes the right column; its tree and review choices are kept for the next open. */
export function withoutTabs(state: ReadingWorkspace, keys: readonly string[]): ReadingWorkspace {
	const closing = new Set(keys);
	const tabs = state.tabs.filter((tab) => !closing.has(tab.key));
	return {
		...state,
		tabs,
		panel: { ...state.panel, open: state.panel.open && tabs.length > 0 },
		activeKey: tabAfterClosing(state.tabs, state.activeKey, closing),
	};
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
		let state = update(previous);
		if (state === previous) return;
		const dirty = get(dirtyFileDocumentsAtom);
		if (state.tabs.length > VIEWER_TAB_LIMIT) {
			const tabs = [...state.tabs];
			while (tabs.length > VIEWER_TAB_LIMIT) {
				const index = tabs.findIndex(
					(tab) =>
						tab.key !== state.activeKey && !(tab.kind === "file" && dirty.has(fileDocumentKey(tab.cwd, tab.path))),
				);
				if (index < 0) break;
				tabs.splice(index, 1);
			}
			state = { ...state, tabs };
		}
		const next = new Map(all);
		next.delete(key);
		next.set(key, { ref, state });
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
	(_get, set, { ref, tab }: { ref: SessionRef; tab: WorkspaceViewerTab }) => {
		set(updateReadingWorkspaceAtom, {
			ref,
			update: (current) => withOpenedTab(current, tab),
		});
	},
);

export const closeReadingTabsAtom = atom(
	null,
	(_get, set, { ref, keys }: { ref: SessionRef; keys: readonly string[] }) => {
		set(updateReadingWorkspaceAtom, { ref, existingOnly: true, update: (current) => withoutTabs(current, keys) });
	},
);

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
				};
			},
		});
	},
);
