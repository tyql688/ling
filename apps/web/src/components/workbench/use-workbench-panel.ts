import type { ChangeReviewScope } from "@ling/contracts/git";
import { useCallback, useMemo, type Dispatch, type SetStateAction } from "react";

/**
 * Mutually exclusive tools rendered in the workspace side panel. `picker` is the opening state:
 * it offers the tools instead of assuming one, so the panel never lands the reader in a file tree
 * they did not ask for.
 */
export type WorkbenchSidePanelMode = "picker" | "explorer" | "review" | "piConfig" | "skills" | "dock";

export interface WorkbenchPanelState {
	/** The reading area and contextual sidebar collapse together without closing their contents. */
	open: boolean;
	sideMode: WorkbenchSidePanelMode | null;
	/** Branch history opens from the Changes panel and does not replace it. */
	historyOpen: boolean;
	/** File focus: expand parent directories and select the preview; directory focus: only expand that directory, no file preview. */
	explorerFocus: { path: string; directory: boolean } | null;
	reviewScope: Extract<ChangeReviewScope, "turn" | "session" | "workspace" | "unpushed">;
	reviewTurnId: string | null;
	reviewFocusFile: string | null;
	/** Last side-panel tab shown; the platform shortcut modifier plus J reopens it. */
	lastSideMode: WorkbenchSidePanelMode;
}

interface WorkbenchPanelController extends WorkbenchPanelState {
	explorerOpen: boolean;
	reviewOpen: boolean;
	dockOpen: boolean;
	openExplorer: (focus?: { path: string; directory?: boolean }) => void;
	clearExplorerFocus: () => void;
	openReviewSession: (focusFile?: string) => void;
	openReviewWorkspace: (focusFile?: string) => void;
	openReviewUnpushed: (focusFile?: string) => void;
	openReviewTurn: (turnId: string | null, focusFile?: string) => void;
	setReviewOpen: (open: boolean) => void;
	clearReviewFocusFile: () => void;
	setHistoryOpen: (open: boolean) => void;
	openSideMode: (mode: WorkbenchSidePanelMode) => void;
	/** Platform shortcut modifier plus J: close the side panel, or reopen its last tab. */
	toggleSidePanel: () => void;
	close: () => void;
}

/** Initial workbench state: side panel closed, its first open offers the tool picker. */
export const INITIAL_WORKBENCH_PANEL_STATE: WorkbenchPanelState = {
	open: false,
	sideMode: null,
	historyOpen: false,
	explorerFocus: null,
	reviewScope: "session",
	reviewTurnId: null,
	reviewFocusFile: null,
	lastSideMode: "picker",
};

/** Switches the side tool, clearing one-shot focus requests and remembering the last tab. */
function switched(current: WorkbenchPanelState, sideMode: WorkbenchSidePanelMode | null): WorkbenchPanelState {
	return {
		...current,
		open: sideMode !== null,
		sideMode,
		explorerFocus: null,
		reviewFocusFile: null,
		lastSideMode: sideMode ?? current.lastSideMode,
	};
}

export function useWorkbenchPanel(
	state: WorkbenchPanelState,
	setState: Dispatch<SetStateAction<WorkbenchPanelState>>,
): WorkbenchPanelController {
	const openExplorer = useCallback(
		(focus?: { path: string; directory?: boolean }) => {
			setState((current) => ({
				...switched(current, "explorer"),
				explorerFocus: focus === undefined ? null : { path: focus.path, directory: focus.directory === true },
			}));
		},
		[setState],
	);
	const clearExplorerFocus = useCallback(() => {
		setState((current) => (current.explorerFocus === null ? current : { ...current, explorerFocus: null }));
	}, [setState]);
	const openReviewSession = useCallback(
		(focusFile?: string) => {
			setState((current) => ({
				...switched(current, "review"),
				reviewScope: "session",
				reviewFocusFile: focusFile ?? null,
			}));
		},
		[setState],
	);
	const openReviewWorkspace = useCallback(
		(focusFile?: string) => {
			setState((current) => ({
				...switched(current, "review"),
				reviewScope: "workspace",
				reviewFocusFile: focusFile ?? null,
			}));
		},
		[setState],
	);
	const openReviewUnpushed = useCallback(
		(focusFile?: string) => {
			setState((current) => ({
				...switched(current, "review"),
				reviewScope: "unpushed",
				reviewFocusFile: focusFile ?? null,
			}));
		},
		[setState],
	);
	const openReviewTurn = useCallback(
		(turnId: string | null, focusFile?: string) => {
			setState((current) => ({
				...switched(current, "review"),
				reviewScope: "turn",
				reviewTurnId: turnId,
				reviewFocusFile: focusFile ?? null,
			}));
		},
		[setState],
	);
	const setReviewOpen = useCallback(
		(open: boolean) => {
			setState((current) => {
				if (open) return switched(current, "review");
				return current.sideMode === "review" ? switched(current, null) : current;
			});
		},
		[setState],
	);
	const clearReviewFocusFile = useCallback(() => {
		setState((current) => (current.reviewFocusFile === null ? current : { ...current, reviewFocusFile: null }));
	}, [setState]);
	const setHistoryOpen = useCallback(
		(open: boolean) => {
			setState((current) => (current.historyOpen === open ? current : { ...current, historyOpen: open }));
		},
		[setState],
	);
	const openSideMode = useCallback(
		(mode: WorkbenchSidePanelMode) => {
			setState((current) => switched(current, mode));
		},
		[setState],
	);
	const toggleSidePanel = useCallback(() => {
		setState((current) => ({ ...current, open: !current.open, sideMode: current.sideMode ?? current.lastSideMode }));
	}, [setState]);
	const close = useCallback(() => {
		setState((current) => (current.open ? { ...current, open: false, historyOpen: false } : current));
	}, [setState]);

	return useMemo(
		() => ({
			...state,
			explorerOpen: state.open && state.sideMode === "explorer",
			reviewOpen: state.open && state.sideMode === "review",
			dockOpen: state.open && state.sideMode === "dock",
			openExplorer,
			clearExplorerFocus,
			openReviewSession,
			openReviewWorkspace,
			openReviewUnpushed,
			openReviewTurn,
			setReviewOpen,
			clearReviewFocusFile,
			setHistoryOpen,
			openSideMode,
			toggleSidePanel,
			close,
		}),
		[
			state,
			openExplorer,
			clearExplorerFocus,
			openReviewSession,
			openReviewWorkspace,
			openReviewUnpushed,
			openReviewTurn,
			setReviewOpen,
			clearReviewFocusFile,
			setHistoryOpen,
			openSideMode,
			toggleSidePanel,
			close,
		],
	);
}
