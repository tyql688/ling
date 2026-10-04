import type { FeaturePageId } from "@renderer/components/workbench/feature-navigation";
import { useCallback, useMemo } from "react";
import {
	featureTabKey,
	type ReadingWorkspace,
	type WorkbenchPanelState,
	type WorkbenchReviewScope,
	withFeatureTab,
	withOpenColumn,
	withoutTabs,
} from "./reading-state";

type ReadingUpdate = (update: (current: ReadingWorkspace) => ReadingWorkspace) => void;

function withPanel(state: ReadingWorkspace, panel: Partial<WorkbenchPanelState>): ReadingWorkspace {
	return { ...state, panel: { ...state.panel, ...panel } };
}

/** File browsing opens the tree beside its own empty reader. */
function withFileTree(state: ReadingWorkspace): ReadingWorkspace {
	return withPanel(withFeatureTab(state, "files"), { treeOpen: true });
}

/** The right column: one tab strip for every tool, plus the file tree docked beside its content. */
export function useWorkbenchPanel(panel: WorkbenchPanelState, setReading: ReadingUpdate) {
	const openTool = useCallback(
		(id: FeaturePageId) => setReading((current) => withFeatureTab(current, id)),
		[setReading],
	);
	const openReview = useCallback(
		(scope: WorkbenchReviewScope, options: { turnId?: string | null; focusFile?: string } = {}) =>
			setReading((current) =>
				withFeatureTab(
					withPanel(current, {
						reviewScope: scope,
						reviewTurnId: scope === "turn" ? (options.turnId ?? null) : current.panel.reviewTurnId,
						reviewFocusFile: options.focusFile ?? null,
					}),
					"changes",
				),
			),
		[setReading],
	);
	/** Platform shortcut modifier plus backquote: close the active terminal tab, or open and activate it. */
	const toggleTerminal = useCallback(
		() =>
			setReading((current) =>
				current.panel.open && current.activeKey === featureTabKey("terminal")
					? withoutTabs(current, [featureTabKey("terminal")])
					: withFeatureTab(current, "terminal"),
			),
		[setReading],
	);
	const closeReview = useCallback(
		() => setReading((current) => withoutTabs(current, [featureTabKey("changes")])),
		[setReading],
	);
	const openTree = useCallback(
		(focus?: { path: string; directory?: boolean }) =>
			setReading((current) =>
				withFileTree(
					withPanel(current, {
						explorerFocus: focus === undefined ? null : { path: focus.path, directory: focus.directory === true },
					}),
				),
			),
		[setReading],
	);
	const toggleTree = useCallback(
		() =>
			setReading((current) =>
				current.panel.open &&
				current.panel.treeOpen &&
				current.tabs.some(
					(tab) =>
						tab.key === current.activeKey && (tab.kind === "file" || (tab.kind === "feature" && tab.id === "files")),
				)
					? withPanel(current, { treeOpen: false, explorerFocus: null })
					: withFileTree(current),
			),
		[setReading],
	);
	const closeTree = useCallback(
		() => setReading((current) => withPanel(current, { treeOpen: false, explorerFocus: null })),
		[setReading],
	);
	const clearExplorerFocus = useCallback(
		() =>
			setReading((current) =>
				current.panel.explorerFocus === null ? current : withPanel(current, { explorerFocus: null }),
			),
		[setReading],
	);
	const clearReviewFocusFile = useCallback(
		() =>
			setReading((current) =>
				current.panel.reviewFocusFile === null ? current : withPanel(current, { reviewFocusFile: null }),
			),
		[setReading],
	);
	const setReviewScope = useCallback(
		(reviewScope: WorkbenchReviewScope) => setReading((current) => withPanel(current, { reviewScope })),
		[setReading],
	);
	const setHistoryOpen = useCallback(
		(historyOpen: boolean) =>
			setReading((current) =>
				current.panel.historyOpen === historyOpen ? current : withPanel(current, { historyOpen }),
			),
		[setReading],
	);
	/** Platform shortcut modifier plus J: hide the right column, or reopen it with its tabs. */
	const toggle = useCallback(
		() =>
			setReading((current) =>
				current.panel.open ? withPanel(current, { open: false, historyOpen: false }) : withOpenColumn(current),
			),
		[setReading],
	);
	const close = useCallback(
		() =>
			setReading((current) => (current.panel.open ? withPanel(current, { open: false, historyOpen: false }) : current)),
		[setReading],
	);

	return useMemo(
		() => ({
			...panel,
			openTool,
			openReview,
			toggleTerminal,
			closeReview,
			openTree,
			toggleTree,
			closeTree,
			clearExplorerFocus,
			clearReviewFocusFile,
			setReviewScope,
			setHistoryOpen,
			toggle,
			close,
		}),
		[
			panel,
			openTool,
			openReview,
			toggleTerminal,
			closeReview,
			openTree,
			toggleTree,
			closeTree,
			clearExplorerFocus,
			clearReviewFocusFile,
			setReviewScope,
			setHistoryOpen,
			toggle,
			close,
		],
	);
}
