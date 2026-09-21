import { useCallback, type SetStateAction } from "react";
import { useReadingWorkspace } from "./reading-state";
import { useWorkbenchLayout } from "@renderer/components/workbench/workbench-layout-context";
import { useSessionExtensionMeta } from "@renderer/features/chat/extension-ui/use-session-extension-meta";
import { useTerminals } from "@renderer/features/terminal/use-terminal-controller";
import { useCommandFeedback } from "@renderer/hooks/use-command-feedback";
import { useWorkspaceGlobalShortcuts } from "./workspace-global-shortcuts";
import { useWorkspaceSessionMenus } from "./workspace-session-menus";
import {
	useWorkspaceField,
	useWorkspaceOwner,
	workspacePanelAtom,
	workspaceSelectionAtom,
	workspaceSidebarAtom,
	workspaceTabsAtom,
} from "./workspace-state";
export function WorkspaceShortcuts() {
	const { toggleSidePanel, sideVisible } = useWorkbenchLayout();
	const visible = useWorkspaceField(workspaceSelectionAtom, "visible");
	const activeSessionRef = useWorkspaceField(workspaceSelectionAtom, "activeSessionRef");
	const runtimeSessionRef = useWorkspaceField(workspaceSelectionAtom, "runtimeSessionRef");
	const shellSidebar = useWorkspaceField(workspaceSidebarAtom, "shellSidebar");
	const showCommandError = useCommandFeedback();
	const { startNewConversation } = useWorkspaceSessionMenus();
	const workbenchPanel = useWorkspaceOwner(workspacePanelAtom);
	const { closeActiveTab, selectAdjacentTab } = useWorkspaceOwner(workspaceTabsAtom);

	const terminalController = useTerminals();
	const [, setReading] = useReadingWorkspace(activeSessionRef);
	const setTerminalOpen = useCallback(
		(update: SetStateAction<boolean>) =>
			setReading((current) => ({
				...current,
				terminalOpen: typeof update === "function" ? update(current.terminalOpen) : update,
			})),
		[setReading],
	);
	const extensionUiState = useSessionExtensionMeta(runtimeSessionRef);

	useWorkspaceGlobalShortcuts({
		enabled: visible,
		activeSessionRef,
		terminalInputListening: extensionUiState.terminalInputListening,
		onNewConversation: () => startNewConversation(),
		closeActiveTab,
		selectAdjacentTab,
		toggleSidebar: shellSidebar.toggleSidebar,
		dismissSheet: shellSidebar.dismissSheet,
		toggleExplorer: () => {
			if (activeSessionRef === null) return;
			if (workbenchPanel.sideMode === "explorer" && sideVisible) toggleSidePanel();
			else {
				// Narrow layouts may retain the selected tool while its sheet is hidden.
				if (!sideVisible) toggleSidePanel();
				workbenchPanel.openExplorer();
			}
		},
		toggleSidePanel: () => {
			if (activeSessionRef !== null) toggleSidePanel();
		},
		setTerminalOpen,
		createTerminal: terminalController.createTerminal,
		terminalLoading: terminalController.loading,
		showCommandError,
	});
	return null;
}
