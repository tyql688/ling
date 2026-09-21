import { useSessionExtensionMeta } from "@renderer/features/chat/extension-ui/use-session-extension-meta";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { WorkspaceTabs } from "./workspace-tabs";
import { useWorkspaceSessionMenus } from "./workspace-session-menus";
import {
	useWorkspaceField,
	useWorkspaceOwner,
	workspaceHistoryAtom,
	workspaceSelectionAtom,
	workspaceSidebarAtom,
	workspaceTabsAtom,
} from "./workspace-state";
import { WorkspaceTitlebar } from "./workspace-titlebar";
import { WorkspaceHeaderActions } from "./workspace-tools";

/** The window's top-level chrome row: session tabs and the window-level workspace controls. */
export function WorkspaceChrome() {
	const { t } = useTranslation();
	const runtimeSessionRef = useWorkspaceField(workspaceSelectionAtom, "runtimeSessionRef");
	const activeSession = useWorkspaceField(workspaceSelectionAtom, "activeSession");
	const shellSidebar = useWorkspaceField(workspaceSidebarAtom, "shellSidebar");
	const { tabSessionMenu, startNewConversation } = useWorkspaceSessionMenus();
	const tabs = useWorkspaceOwner(workspaceTabsAtom);
	const state = tabs.conversationGroup;
	const sessionNavigation = useWorkspaceOwner(workspaceHistoryAtom);
	const extension = useSessionExtensionMeta(runtimeSessionRef);
	const activeTitle = extension.title ?? activeSession?.title;
	useEffect(() => {
		document.title = activeTitle ? `${activeTitle} - Ling` : "Ling";
	}, [activeTitle]);
	return (
		<WorkspaceTitlebar
			sidebar={shellSidebar}
			history={sessionNavigation}
			workingSet={
				state.tabs.length > 0 ? (
					<WorkspaceTabs
						tabs={state.tabs}
						activeKey={state.activeKey}
						label={t("reading.conversationTabs")}
						menuFor={tabSessionMenu}
						onSelect={state.select}
						onKeepOpen={state.keepOpen}
						onClose={state.close}
						onCloseOthers={state.closeOthers}
						onCloseRight={state.closeRight}
						onCloseAll={state.closeAll}
						onReorder={state.reorder}
						onNewSession={() => startNewConversation()}
					/>
				) : null
			}
			tools={<WorkspaceHeaderActions />}
		/>
	);
}

/**
 * The reading column's own tab strip. It is shorter than the chrome row and carries no window
 * controls, so its tabs read as nested inside that column instead of as siblings of the session tabs.
 */
export function WorkspaceReadingStrip() {
	const { t } = useTranslation();
	const tabs = useWorkspaceOwner(workspaceTabsAtom);
	const state = tabs.readingGroup;
	if (state.tabs.length === 0) return null;
	return (
		<div className="flex h-9 shrink-0 items-center px-1.5">
			<WorkspaceTabs
				tabs={state.tabs}
				activeKey={state.activeKey}
				label={t("reading.fileTabs")}
				onSelect={state.select}
				onKeepOpen={state.keepOpen}
				onClose={state.close}
				onCloseOthers={state.closeOthers}
				onCloseRight={state.closeRight}
				onCloseAll={state.closeAll}
				onReorder={state.reorder}
			/>
		</div>
	);
}
