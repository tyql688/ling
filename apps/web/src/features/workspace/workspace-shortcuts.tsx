import { useWorkbenchLayout } from "@renderer/components/workbench/workbench-layout-context";
import { useSessionExtensionMeta } from "@renderer/features/chat/extension-ui/use-session-extension-meta";
import { useTerminals } from "@renderer/features/terminal/use-terminal-controller";
import { useCommandFeedback } from "@renderer/hooks/use-command-feedback";
import { useWorkspaceGlobalShortcuts } from "./workspace-global-shortcuts";
import {
	useWorkspaceField,
	useWorkspaceOwner,
	workspacePanelAtom,
	workspaceSelectionAtom,
	workspaceSessionActionsAtom,
	workspaceSidebarAtom,
	workspaceTabsAtom,
} from "./workspace-state";
export function WorkspaceShortcuts() {
	const { toggleSidePanel } = useWorkbenchLayout();
	const visible = useWorkspaceField(workspaceSelectionAtom, "visible");
	const activeSessionRef = useWorkspaceField(workspaceSelectionAtom, "activeSessionRef");
	const runtimeSessionRef = useWorkspaceField(workspaceSelectionAtom, "runtimeSessionRef");
	const shellSidebar = useWorkspaceField(workspaceSidebarAtom, "shellSidebar");
	const showCommandError = useCommandFeedback();
	const { handleNewConversation } = useWorkspaceOwner(workspaceSessionActionsAtom);
	const workbenchPanel = useWorkspaceOwner(workspacePanelAtom);
	const { closeActiveView, selectAdjacentTab } = useWorkspaceOwner(workspaceTabsAtom);

	const terminalController = useTerminals();
	const extensionUiState = useSessionExtensionMeta(runtimeSessionRef);

	useWorkspaceGlobalShortcuts({
		enabled: visible,
		activeSessionRef,
		terminalInputListening: extensionUiState.terminalInputListening,
		onNewConversation: () => handleNewConversation(),
		closeActiveView,
		selectAdjacentTab,
		toggleSidebar: shellSidebar.toggleSidebar,
		dismissSheet: shellSidebar.dismissSheet,
		toggleExplorer: () => {
			if (activeSessionRef !== null) workbenchPanel.toggleTree();
		},
		toggleSidePanel: () => {
			if (activeSessionRef !== null) toggleSidePanel();
		},
		toggleTerminal: workbenchPanel.toggleTerminal,
		openTerminal: () => workbenchPanel.openTool("terminal"),
		createTerminal: terminalController.createTerminal,
		terminalLoading: terminalController.loading,
		showCommandError,
	});
	return null;
}
