import { CHROME_TITLEBAR_CLASS } from "@renderer/components/shell-chrome";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { IconButton } from "@renderer/components/ui/icon-button";
import { useWorkbenchLayout } from "@renderer/components/workbench/workbench-layout-context";
import { useSessionExtensionMeta } from "@renderer/features/chat/extension-ui/use-session-extension-meta";
import { useReviewWorkspace } from "@renderer/features/review/use-review-workspace";
import { sessionMenuGroups } from "@renderer/features/sessions/session-menu";
import { sessionKey, toSessionRef } from "@ling/contracts/session-ref";
import { useCommandFeedback } from "@renderer/hooks/use-command-feedback";
import { useDomainApi } from "@renderer/lib/host-api-context";
import { dragRegionClassName } from "@renderer/lib/platform";
import { cn } from "@renderer/lib/utils";
import { Ellipsis, MessageCircle } from "lucide-react";
import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useWorkspaceDialogs } from "./use-workspace-dialogs";
import { WorkspaceTabs } from "./workspace-tabs";
import {
	useWorkspaceField,
	useWorkspaceOwner,
	workspaceHistoryAtom,
	workspaceSelectionAtom,
	workspaceSessionActionsAtom,
	workspaceSidebarAtom,
	workspaceTabsAtom,
} from "./workspace-state";
import { WorkspaceNavigationControls, WorkspaceTitlebar } from "./workspace-titlebar";
import { WorkspacePanelActions } from "./workspace-tools";

/** One selected conversation owns the title, independent of its reading tabs. */
export function WorkspaceChrome() {
	const runtimeSessionRef = useWorkspaceField(workspaceSelectionAtom, "runtimeSessionRef");
	const activeSession = useWorkspaceField(workspaceSelectionAtom, "activeSession");
	const shellSidebar = useWorkspaceField(workspaceSidebarAtom, "shellSidebar");
	const sessionNavigation = useWorkspaceOwner(workspaceHistoryAtom);
	const { hasReading, compact, floating, readingOnLeft } = useWorkbenchLayout();
	const expandedTitle = floating && !compact;
	const extension = useSessionExtensionMeta(runtimeSessionRef);
	const activeTitle = extension.title ?? activeSession?.title;
	useEffect(() => {
		document.title = activeTitle ? `${activeTitle} - Ling` : "Ling";
	}, [activeTitle]);
	return (
		<WorkspaceTitlebar
			sidebar={shellSidebar}
			history={sessionNavigation}
			navigation={!readingOnLeft}
			reserveWindowControls={!hasReading || compact || readingOnLeft}
			title={
				<h1
					className={cn(
						"flex min-w-0 items-center gap-1.5 text-ui",
						// Limit the title to 20rem so long names leave room for reading tabs, excluding navigation controls.
						expandedTitle ? "max-w-80 text-text-muted" : "font-medium text-text-primary",
					)}
					title={activeTitle}
				>
					{expandedTitle && <MessageCircle className="size-4 shrink-0" aria-hidden="true" />}
					<span className="truncate">{activeTitle}</span>
				</h1>
			}
			tools={
				<>
					<WorkspaceSessionMenu key={activeSession ? sessionKey(toSessionRef(activeSession)) : "home"} />
					{!hasReading && <WorkspacePanelActions />}
				</>
			}
		/>
	);
}

function WorkspaceSessionMenu() {
	const { t } = useTranslation();
	const activeSession = useWorkspaceField(workspaceSelectionAtom, "activeSession");
	const sessionController = useWorkspaceField(workspaceSelectionAtom, "sessionController");
	const { handleForkWhole, handleCompact } = useWorkspaceOwner(workspaceSessionActionsAtom);
	const dialogs = useWorkspaceDialogs();
	const projectApi = useDomainApi("project");
	const onError = useCommandFeedback();
	if (!activeSession) return null;
	const ref = toSessionRef(activeSession);
	const groups = sessionMenuGroups(
		{
			id: activeSession.id,
			cwd: ref.cwd,
			pinned: activeSession.pinnedAt !== undefined,
			archived: activeSession.archivedAt !== undefined,
		},
		{
			onRename: () => dialogs.openRenameSession(ref, activeSession.title),
			onPin: (pinned) => void sessionController.setSessionPinned(ref, pinned).catch(onError),
			onArchive: (archived) => void sessionController.setSessionArchived(ref, archived).catch(onError),
			onFork: () => void handleForkWhole(ref).catch(onError),
			onCompact: activeSession.relation?.kind === "child" ? undefined : () => void handleCompact(),
			onReveal: () => void projectApi.launchDefault({ cwd: ref.cwd, kind: "file-manager" }).catch(onError),
			onDelete: () => dialogs.requestDeleteSession(ref, activeSession.title),
		},
	);
	return (
		<DropdownMenu>
			<DropdownMenuTrigger render={<IconButton aria-label={t("common.moreActions")} />}>
				<Ellipsis className="size-4" aria-hidden="true" />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-48">
				{groups.map((group, index) => (
					// eslint-disable-next-line react/no-array-index-key -- Session menu groups have a fixed order.
					<div key={index} className="contents">
						{index > 0 && <DropdownMenuSeparator />}
						{group.map((entry) => (
							<DropdownMenuItem
								key={entry.key}
								variant={entry.destructive ? "destructive" : "default"}
								onSelect={entry.onSelect}
							>
								{t(entry.labelKey)}
							</DropdownMenuItem>
						))}
					</div>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/** Right-column tabs use the same 44px row as the conversation title, with 36px tab targets. */
export function WorkspaceReadingStrip() {
	const { t } = useTranslation();
	const tabs = useWorkspaceOwner(workspaceTabsAtom);
	const runtimeSessionRef = useWorkspaceField(workspaceSelectionAtom, "runtimeSessionRef");
	const { compact, readingOnLeft } = useWorkbenchLayout();
	const shellSidebar = useWorkspaceField(workspaceSidebarAtom, "shellSidebar");
	const history = useWorkspaceOwner(workspaceHistoryAtom);
	const showNavigation = readingOnLeft && (shellSidebar.presentation === "sheet" || !shellSidebar.open);
	const { review, files } = useReviewWorkspace();
	const { dockItems } = useSessionExtensionMeta(runtimeSessionRef);
	const changeCount = review.snapshot?.scopes.workspace.count ?? files.files.length;
	const state = tabs.readingGroup;
	const tabItems = useMemo(
		() =>
			state.tabs.map((tab) =>
				tab.kind !== "feature"
					? tab
					: tab.id === "changes"
						? { ...tab, count: changeCount }
						: tab.id === "dock"
							? { ...tab, count: dockItems }
							: tab,
			),
		[changeCount, dockItems, state.tabs],
	);
	if (state.tabs.length === 0) return null;
	return (
		<div
			className={cn("flex min-w-0 shrink-0 items-center gap-1 pl-1.5", CHROME_TITLEBAR_CLASS, dragRegionClassName)}
			style={{
				paddingLeft: showNavigation ? "var(--window-controls-left-padding)" : undefined,
				paddingRight: compact || readingOnLeft ? "0.5rem" : "calc(var(--window-controls-right-padding) + 0.5rem)",
			}}
		>
			{showNavigation && <WorkspaceNavigationControls sidebar={shellSidebar} history={history} />}
			<WorkspaceTabs
				tabs={tabItems}
				activeKey={state.activeKey}
				label={t("reading.fileTabs")}
				onSelect={state.select}
				onClose={state.close}
				onCloseOthers={state.closeOthers}
				onCloseRight={state.closeRight}
				onCloseAll={state.closeAll}
				onReorder={state.reorder}
				onNewTab={() => tabs.openFeatureViewer("new-tab")}
			/>
			<div className="flex shrink-0 items-center gap-0.5">
				<WorkspacePanelActions />
			</div>
		</div>
	);
}
