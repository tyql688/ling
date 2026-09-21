import type { OpenProjectInfo } from "@ling/contracts/project";
import type { SessionSummary } from "@ling/contracts/session";
import { sameSessionRef, sessionKey, type SessionRef, toSessionRef } from "@ling/contracts/session-ref";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { TooltipIconButton } from "@renderer/components/ui/tooltip-icon-button";
import type { ShellSidebarPresentation } from "@renderer/components/use-shell-sidebar";
import {
	pinnedProjectCwdsAtom,
	projectDisplayNamesAtom,
	sidebarProjectScopeAtom,
} from "@renderer/features/projects/state";
import {
	isActivityStatus,
	requireWorkspaceSessionStatus,
	useWorkspaceSessionStatuses,
	type WorkspaceSessionStatusEntry,
} from "@renderer/features/sessions/session-status";
import { TodayUsageSummary } from "@renderer/features/usage/today-usage-summary";
import { NavigationItem } from "@renderer/components/ui/navigation-item";
import { useCommandFeedback } from "@renderer/hooks/use-command-feedback";
import { useDomainApi } from "@renderer/lib/host-api-context";
import { dragRegionClassName, noDragRegionClassName, requestCommandPalette, shortcut } from "@renderer/lib/platform";
import { cn } from "@renderer/lib/utils";
import { useAtom } from "jotai";
import { appPageAtom } from "@renderer/lib/navigation-state";
import { HistoryButtons, type NavigationHistory } from "./workspace-titlebar";
import {
	Archive,
	ChevronDown,
	Clock,
	Clock3,
	Bell,
	FolderPlus,
	PanelLeftClose,
	PanelLeftOpen,
	Search,
	Settings,
	SquarePen,
} from "lucide-react";
import { motion } from "motion/react";
import { type ReactElement, type KeyboardEvent as ReactKeyboardEvent, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { CHROME_TITLEBAR_CLASS } from "../../components/shell-chrome";
import { ProjectActionsContextMenu, ProjectActionsMenu } from "../projects/project-actions-menu";
import { ProjectHoverCard } from "../projects/project-hover-card";
import type { ProjectController } from "../projects/use-projects";
import { SessionListItem } from "../sessions/session-list-item";
import type { SessionController } from "../sessions/use-sessions";
import { useWorkspaceDialogs } from "./use-workspace-dialogs";
import type { WorkspaceSidebarState } from "./use-workspace-sidebar-state";
import { useWorkspaceReviewActions } from "./workspace-review-actions";
import { useWorkspaceSessionMenus } from "./workspace-session-menus";
import { MoreSessionsButton } from "./workspace-sidebar-controls";
import { buildWorkspaceSidebarModel, type WorkspaceSidebarProject } from "./workspace-sidebar-model";
import { ProjectScopeSelector, WorkspaceProjectSessions } from "./workspace-sidebar-project-navigation";
import { WorkspaceSidebarRecent, WorkspaceSidebarSessionSection } from "./workspace-sidebar-recent";
import {
	useWorkspaceField,
	useWorkspaceOwner,
	workspaceHistoryAtom,
	workspaceModelFeedbackAtom,
	workspaceSelectionAtom,
	workspaceSessionActionsAtom,
	workspaceSidebarAtom,
	workspaceTabsAtom,
} from "./workspace-state";

/** Rows per archived "load more". */
const ARCHIVED_PAGE_COUNT = 25;
/** Stable empty list reference when there are no sessions. */
const EMPTY_SESSIONS: readonly SessionSummary[] = [];
/** Fixed ready status for archived sessions, which show no activity badge. */
const ARCHIVED_STATUS: WorkspaceSessionStatusEntry = { status: "ready", queuedCount: 0 };

interface WorkspaceSidebarNavigation {
	toggleSidebar: () => void;
	dismissSheet: () => void;
	newConversation: (cwd?: string) => void;
	openSettings: () => void;
}

interface WorkspaceSidebarSessionActions {
	keepTabOpen: (ref: SessionRef) => void;
	rename: (ref: SessionRef, title: string) => void;
	fork: (ref: SessionRef) => Promise<void>;
	requestDelete: (ref: SessionRef, title: string) => void;
	/** Compact for the ACTIVE session only — the runtime command needs its live binding. */
	compactActive?: (() => void) | undefined;
}

interface WorkspaceSidebarProjectActions {
	requestCreateWorktree: (project: OpenProjectInfo) => void;
	requestShowChanges: (project: OpenProjectInfo) => void;
	requestRemoveWorktree: (project: OpenProjectInfo) => void;
	requestRemoveProject: (project: OpenProjectInfo) => void;
}

function routeNewConversation(
	navigation: Pick<WorkspaceSidebarNavigation, "dismissSheet" | "newConversation">,
	cwd?: string,
): void {
	navigation.newConversation(cwd);
	navigation.dismissSheet();
}

interface WorkspaceSidebarProps {
	projectController: ProjectController;
	sessionController: SessionController;
	presentation: ShellSidebarPresentation;
	previewing: boolean;
	navigation: WorkspaceSidebarNavigation;
	history: NavigationHistory;
	sessionActions: WorkspaceSidebarSessionActions;
	projectActions: WorkspaceSidebarProjectActions;
	state: WorkspaceSidebarState;
	onError: (error: unknown) => void;
}

function WorkspaceSidebar({
	projectController,
	sessionController,
	presentation,
	previewing,
	navigation,
	history,
	sessionActions,
	projectActions,
	state,
	onError,
}: WorkspaceSidebarProps) {
	const hostProjectApi = useDomainApi("project");

	const { t } = useTranslation();
	const { projects, addProject } = projectController;
	const { sessions, activeSessionRef, selectSession, setSessionPinned, setSessionArchived } = sessionController;
	const [pinnedProjectCwds, setPinnedProjectCwds] = useAtom(pinnedProjectCwdsAtom);
	const [projectDisplayNames, setProjectDisplayNames] = useAtom(projectDisplayNamesAtom);
	const [projectScopeCwd, setProjectScopeCwd] = useAtom(sidebarProjectScopeAtom);
	const [appPage, setAppPage] = useAtom(appPageAtom);
	const [now, setNow] = useState(() => Date.now());
	const usageRefreshAt = sessions.reduce((latest, session) => Math.max(latest, session.updatedAt), now);
	useEffect(() => {
		const refresh = () => setNow(Date.now());
		const timer = window.setInterval(refresh, 60_000);
		window.addEventListener("focus", refresh);
		return () => {
			window.clearInterval(timer);
			window.removeEventListener("focus", refresh);
		};
	}, []);
	const model = useMemo(
		() =>
			buildWorkspaceSidebarModel({
				projects,
				sessions,
				pinnedProjectCwds,
				projectDisplayNames,
				projectScopeCwd,
			}),
		[projects, sessions, pinnedProjectCwds, projectDisplayNames, projectScopeCwd],
	);
	const statuses = useWorkspaceSessionStatuses(model.activeSessions, activeSessionRef);
	const sessionsByCwd = useMemo(
		() =>
			Map.groupBy(
				sessions.filter((session) => session.relation?.kind !== "child"),
				(session) => session.cwd,
			),
		[sessions],
	);
	const activityCountByCwd = useMemo(() => {
		const counts = new Map<string, number>();
		for (const session of model.activeSessions) {
			if (!isActivityStatus(requireWorkspaceSessionStatus(statuses, session).status)) continue;
			const current = counts.get(session.cwd);
			counts.set(session.cwd, current === undefined ? 1 : current + 1);
		}
		return counts;
	}, [model.activeSessions, statuses]);
	const openProjectEntries = model.projects.filter((entry) => entry.projectOpen);
	const scopedProject = model.scopedProject;
	const newConversationCwd =
		scopedProject?.projectOpen === true
			? scopedProject.project.cwd
			: scopedProject === null && openProjectEntries.length === 1
				? openProjectEntries[0]?.project.cwd
				: undefined;
	const canCreateConversation = scopedProject === null ? openProjectEntries.length > 0 : scopedProject.projectOpen;
	const activeKey = activeSessionRef === null ? null : sessionKey(activeSessionRef);
	const archivedVisible = model.archivedSessions.slice(0, state.archivedVisibleCount);
	const selectedArchivedBeyondLimit =
		activeKey === null
			? undefined
			: model.archivedSessions.find(
					(session, index) => index >= state.archivedVisibleCount && sessionKey(toSessionRef(session)) === activeKey,
				);
	const visibleArchivedSessions =
		selectedArchivedBeyondLimit === undefined ? archivedVisible : [...archivedVisible, selectedArchivedBeyondLimit];
	const hiddenArchivedCount = model.archivedSessions.length - visibleArchivedSessions.length;
	const pinnedSessions = model.activeSessions.filter((session) => session.pinnedAt !== undefined);

	const projectSessions = (cwd: string): readonly SessionSummary[] => {
		const grouped = sessionsByCwd.get(cwd);
		return grouped === undefined ? EMPTY_SESSIONS : grouped;
	};
	const projectActivityCount = (cwd: string): number => {
		const count = activityCountByCwd.get(cwd);
		return count === undefined ? 0 : count;
	};
	const projectName = (cwd: string): string => {
		const name = model.projectNameByCwd.get(cwd);
		if (name === undefined) throw new Error(`Missing sidebar project for ${cwd}`);
		return name;
	};
	const archiveSessions = async (targetSessions: readonly SessionSummary[]) => {
		try {
			for (const session of targetSessions) {
				if (session.archivedAt === undefined) await setSessionArchived(toSessionRef(session), true);
			}
		} catch (error) {
			onError(error);
		}
	};
	const selectSidebarSession = (session: SessionSummary) => {
		navigation.dismissSheet();
		void selectSession(toSessionRef(session)).catch(onError);
	};
	const togglePinnedProject = (cwd: string) => {
		setPinnedProjectCwds((current) =>
			current.includes(cwd) ? current.filter((item) => item !== cwd) : [cwd, ...current],
		);
	};
	const renameProject = (cwd: string, currentName: string) => {
		const nextName = window.prompt(t("project.renamePrompt"), currentName)?.trim();
		if (!nextName || nextName === currentName) return;
		setProjectDisplayNames((current) => ({ ...current, [cwd]: nextName }));
	};
	const revealProject = (cwd: string) => {
		void hostProjectApi.launchDefault({ cwd, kind: "file-manager" }).catch(onError);
	};
	const handleSessionListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
		if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
		const target = event.target as HTMLElement;
		const rows = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-session-key]")];
		const index = rows.indexOf(target);
		if (index === -1) return;
		event.preventDefault();
		rows[event.key === "ArrowDown" ? index + 1 : index - 1]?.focus();
	};
	const renderSession = (session: SessionSummary, variant: "active" | "archived", showProjectContext: boolean) => (
		<motion.div
			key={sessionKey(toSessionRef(session))}
			layout="position"
			initial={{ opacity: 0 }}
			animate={{ opacity: 1 }}
			exit={{ opacity: 0 }}
			transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
			className="overflow-hidden motion-reduce:transition-none"
		>
			<SessionListItem
				session={session}
				projectName={projectName(session.cwd)}
				showProjectContext={showProjectContext}
				isActive={sameSessionRef(toSessionRef(session), activeSessionRef)}
				variant={variant}
				status={variant === "archived" ? ARCHIVED_STATUS : requireWorkspaceSessionStatus(statuses, session)}
				now={now}
				onSelect={() => selectSidebarSession(session)}
				onKeepOpen={() => sessionActions.keepTabOpen(toSessionRef(session))}
				onRename={(title) => sessionActions.rename(toSessionRef(session), title)}
				onFork={() => void sessionActions.fork(toSessionRef(session)).catch(onError)}
				onPin={(pinned) => void setSessionPinned(toSessionRef(session), pinned).catch(onError)}
				onArchive={(archived) => void setSessionArchived(toSessionRef(session), archived).catch(onError)}
				onDelete={() => sessionActions.requestDelete(toSessionRef(session), session.title)}
				onReveal={() => revealProject(session.cwd)}
				onCompact={sameSessionRef(toSessionRef(session), activeSessionRef) ? sessionActions.compactActive : undefined}
			/>
		</motion.div>
	);
	const projectActionProps = (entry: WorkspaceSidebarProject) => ({
		...entry,
		pinned: entry.pinned,
		sessions: projectSessions(entry.project.cwd),
		onNewSession: (cwd: string) => routeNewConversation(navigation, cwd),
		onTogglePinned: togglePinnedProject,
		onRename: renameProject,
		onArchiveSessions: (targetSessions: readonly SessionSummary[]) => void archiveSessions(targetSessions),
		onCreateWorktree: projectActions.requestCreateWorktree,
		onRemoveWorktree: projectActions.requestRemoveWorktree,
		onReveal: revealProject,
		onShowChanges: projectActions.requestShowChanges,
		onOpenEditor: (cwd: string) => void hostProjectApi.launchDefault({ cwd, kind: "editor" }).catch(onError),
		onOpenTerminal: (cwd: string) => void hostProjectApi.launchDefault({ cwd, kind: "terminal" }).catch(onError),
		onCopyPath: (cwd: string) => void navigator.clipboard.writeText(cwd).catch(onError),
		onRemoveProject: () => {
			if (entry.projectOpen) projectActions.requestRemoveProject(entry.project);
		},
	});
	const renderProjectActionsMenu = (
		entry: WorkspaceSidebarProject,
		trigger?: ReactElement,
		onOpenChange?: (open: boolean) => void,
	) => (
		<ProjectActionsMenu
			{...projectActionProps(entry)}
			{...(trigger === undefined ? {} : { trigger })}
			{...(onOpenChange === undefined ? {} : { onOpenChange })}
		/>
	);
	const renderProjectContextMenu = (
		entry: WorkspaceSidebarProject,
		trigger: ReactElement,
		onOpenChange: (open: boolean) => void,
	) => <ProjectActionsContextMenu {...projectActionProps(entry)} trigger={trigger} onOpenChange={onOpenChange} />;
	const renderProjectHoverCard = (entry: WorkspaceSidebarProject, trigger: ReactElement, disabled?: boolean) => (
		<ProjectHoverCard
			project={entry.project}
			pinned={entry.pinned}
			sessionCount={entry.sessionCount}
			activityCount={projectActivityCount(entry.project.cwd)}
			trigger={trigger}
			side={presentation === "sheet" ? "bottom" : "right"}
			disabled={disabled}
			renderMoreActions={(actionsTrigger, onOpenChange) =>
				renderProjectActionsMenu(entry, actionsTrigger, onOpenChange)
			}
			renderContextMenu={(contextTrigger, onOpenChange) =>
				renderProjectContextMenu(entry, contextTrigger, onOpenChange)
			}
			onTogglePinned={() => togglePinnedProject(entry.project.cwd)}
			onReveal={() => revealProject(entry.project.cwd)}
		/>
	);

	const scopeSelector = (
		<ProjectScopeSelector
			projects={model.projects}
			scopedProject={scopedProject}
			renderProjectHoverCard={renderProjectHoverCard}
			onScopeChange={setProjectScopeCwd}
			onAddProject={() => void addProject().catch(onError)}
		/>
	);
	const allViewContent = (
		<>
			{pinnedSessions.length > 0 && (
				<div className="mb-3">
					<WorkspaceSidebarSessionSection
						label={t("sidebar.pinned")}
						sessions={pinnedSessions}
						renderSession={(session) => renderSession(session, "active", scopedProject === null)}
					/>
				</div>
			)}
			<WorkspaceProjectSessions
				projects={model.projects}
				scopedProject={scopedProject}
				activeSessions={model.activeSessions}
				activeSessionRef={activeSessionRef}
				activityCountByCwd={activityCountByCwd}
				renderProjectHoverCard={renderProjectHoverCard}
				renderSession={(session) => renderSession(session, "active", false)}
			/>
		</>
	);

	return (
		<div className="flex h-full min-w-0 flex-col">
			<div
				style={{ paddingLeft: "var(--window-controls-left-padding)" }}
				className={cn("flex shrink-0 items-center pr-2", CHROME_TITLEBAR_CLASS, dragRegionClassName)}
			>
				<div className={cn("flex items-center gap-0.5", noDragRegionClassName)}>
					<TooltipIconButton
						onClick={navigation.toggleSidebar}
						label={t(previewing ? "nav.pinSidebar" : "nav.closeSidebar")}
						shortcut={shortcut("B")}
					>
						{previewing ? (
							<PanelLeftOpen className="size-4" aria-hidden="true" />
						) : (
							<PanelLeftClose className="size-4" aria-hidden="true" />
						)}
					</TooltipIconButton>
					<HistoryButtons history={history} />
				</div>
			</div>
			<div className="flex h-14 shrink-0 items-center gap-1 px-3">
				{scopeSelector}
				<TooltipIconButton
					onClick={() => {
						requestCommandPalette();
						navigation.dismissSheet();
					}}
					label={t("nav.search")}
					shortcut={shortcut("K")}
				>
					<Search className="size-4" aria-hidden="true" />
				</TooltipIconButton>
				<TooltipIconButton
					onClick={() => state.setView(state.view === "recent" ? "all" : "recent")}
					label={t(state.view === "recent" ? "sidebar.focusOn" : "sidebar.focusOff")}
					aria-pressed={state.view === "recent"}
					className={cn(state.view === "recent" && "bg-surface-hover text-text-primary")}
				>
					<Bell className="size-4" aria-hidden="true" />
				</TooltipIconButton>
			</div>
			<div className="flex shrink-0 flex-col gap-1 px-2 pb-3">
				<div className="flex items-center gap-1">
					<Tooltip>
						<TooltipTrigger
							render={
								<NavigationItem
									icon={<SquarePen aria-hidden="true" />}
									onClick={() => routeNewConversation(navigation, newConversationCwd)}
									disabled={!canCreateConversation}
									className="flex-1"
								/>
							}
						>
							<span>{t("nav.newConversation")}</span>
						</TooltipTrigger>
						<TooltipContent shortcut={shortcut("N")}>{t("nav.newConversation")}</TooltipContent>
					</Tooltip>
					{scopedProject && renderProjectActionsMenu(scopedProject)}
				</div>
				<NavigationItem
					icon={<Clock aria-hidden="true" />}
					aria-current={appPage === "schedules" ? "page" : undefined}
					onClick={() => {
						navigation.dismissSheet();
						setAppPage("schedules");
					}}
				>
					{t("schedules.title")}
				</NavigationItem>
			</div>

			{/* eslint-disable-next-line jsx-a11y/no-static-element-interactions -- arrow-key convenience is layered over individually focusable session rows. */}
			<div
				onKeyDown={handleSessionListKeyDown}
				className="min-h-0 flex-1 overflow-y-auto px-2 pb-2 [scrollbar-gutter:stable]"
			>
				{state.view === "recent" ? (
					model.activeSessions.length > 0 ? (
						<WorkspaceSidebarRecent
							sessions={model.activeSessions}
							renderSession={(session) => renderSession(session, "active", scopedProject === null)}
						/>
					) : (
						<div className="flex flex-col items-center gap-2 px-3 py-8 text-center text-xs text-text-muted/70">
							<Clock3 className="size-4" aria-hidden="true" />
							<span>{t("sidebar.noRecent")}</span>
						</div>
					)
				) : (
					<>
						{allViewContent}
						{model.archivedSessions.length > 0 && (
							<div className="mt-3 border-border-subtle border-t pt-1.5">
								<Tooltip>
									<TooltipTrigger
										render={
											<button
												type="button"
												onClick={() => state.setArchivedExpanded((current) => !current)}
												aria-label={t("sidebar.archivedCount", { count: model.archivedSessions.length })}
												aria-expanded={state.archivedExpanded}
												className="flex h-7 w-full items-center gap-2 rounded-control px-2 text-left text-xs tabular-nums text-text-muted transition-colors hover:bg-surface-hover hover:text-text-primary"
											/>
										}
									>
										<Archive className="size-3.5" aria-hidden="true" />
										<span>{model.archivedSessions.length}</span>
										<ChevronDown
											className={cn(
												"ml-auto size-3.5 transition-transform motion-reduce:transition-none",
												state.archivedExpanded && "rotate-180",
											)}
											aria-hidden="true"
										/>
									</TooltipTrigger>
									<TooltipContent>{t("sidebar.archived")}</TooltipContent>
								</Tooltip>
								{state.archivedExpanded && (
									<div className="mt-1 flex flex-col gap-px">
										{visibleArchivedSessions.map((session) => renderSession(session, "archived", false))}
										{hiddenArchivedCount > 0 && (
											<MoreSessionsButton
												count={hiddenArchivedCount}
												label={t("sidebar.showMoreArchived", {
													count: Math.min(hiddenArchivedCount, ARCHIVED_PAGE_COUNT),
													remaining: hiddenArchivedCount,
												})}
												onClick={() => state.setArchivedVisibleCount((current) => current + ARCHIVED_PAGE_COUNT)}
											/>
										)}
									</div>
								)}
							</div>
						)}
						{model.activeSessions.length + model.archivedSessions.length === 0 && (
							<div className="flex flex-col items-center gap-2 px-3 py-8 text-center text-xs text-text-muted/70">
								<span>
									{model.projects.length === 0
										? t("sidebar.noProjects")
										: scopedProject
											? t("sidebar.noProjectSessions", { project: scopedProject.project.name })
											: t("session.noSessions")}
								</span>
								{model.projects.length === 0 && (
									<TooltipIconButton onClick={() => void addProject().catch(onError)} label={t("project.add")}>
										<FolderPlus className="size-3.5" aria-hidden="true" />
									</TooltipIconButton>
								)}
							</div>
						)}
					</>
				)}
			</div>

			<div className="shrink-0 border-border-subtle border-t p-2">
				<WorkspaceTodayUsage refreshAt={usageRefreshAt} />

				<button
					type="button"
					onClick={() => {
						navigation.dismissSheet();
						navigation.openSettings();
					}}
					className="flex h-9 w-full items-center gap-2 rounded-control px-2 text-xs text-text-muted transition-colors hover:bg-surface-hover hover:text-text-primary"
				>
					<Settings className="size-4" aria-hidden="true" />
					<span>{t("nav.settings")}</span>
				</button>
			</div>
		</div>
	);
}

/** Only provider selection reaches the quota footer; streaming transcript updates stay with the conversation. */
function WorkspaceTodayUsage({ refreshAt }: { refreshAt: number }) {
	const currentProviderId = useWorkspaceField(workspaceModelFeedbackAtom, "currentProviderId");
	return <TodayUsageSummary refreshAt={refreshAt} currentProviderId={currentProviderId} />;
}

export function WorkspaceSidebarNavigation() {
	const projectController = useWorkspaceField(workspaceSelectionAtom, "projectController");
	const onOpenSettings = useWorkspaceField(workspaceSelectionAtom, "onOpenSettings");
	const activeSession = useWorkspaceField(workspaceSelectionAtom, "activeSession");
	const activeSessionIsChild = useWorkspaceField(workspaceSelectionAtom, "activeSessionIsChild");
	const shellSidebar = useWorkspaceField(workspaceSidebarAtom, "shellSidebar");
	const workspaceSidebarState = useWorkspaceField(workspaceSidebarAtom, "workspaceSidebarState");
	const sidebarSessionController = useWorkspaceField(workspaceSidebarAtom, "sidebarSessionController");
	const showCommandError = useCommandFeedback();
	const { handleShowProjectChanges } = useWorkspaceReviewActions();
	const { startNewConversation } = useWorkspaceSessionMenus();
	const dialogs = useWorkspaceDialogs();
	const sessionActions = useWorkspaceOwner(workspaceSessionActionsAtom);
	const { keepSessionTabOpen } = useWorkspaceOwner(workspaceTabsAtom);
	const sessionNavigation = useWorkspaceOwner(workspaceHistoryAtom);

	const { handleRenameSession, handleForkWhole, handleCompact } = sessionActions;
	return (
		<WorkspaceSidebar
			projectController={projectController}
			sessionController={sidebarSessionController}
			presentation={shellSidebar.presentation}
			previewing={shellSidebar.previewOpen}
			history={sessionNavigation}
			navigation={{
				toggleSidebar: shellSidebar.toggleSidebar,
				dismissSheet: shellSidebar.dismissSheet,
				newConversation: startNewConversation,
				openSettings: onOpenSettings,
			}}
			sessionActions={{
				keepTabOpen: keepSessionTabOpen,
				rename: (ref, title) => void handleRenameSession(ref, title).catch(showCommandError),
				fork: handleForkWhole,
				requestDelete: dialogs.requestDeleteSession,
				compactActive: activeSession && !activeSessionIsChild ? () => void handleCompact() : undefined,
			}}
			projectActions={{
				requestCreateWorktree: dialogs.openWorktree,
				requestShowChanges: handleShowProjectChanges,
				requestRemoveWorktree: dialogs.requestRemoveWorktree,
				requestRemoveProject: (project) => dialogs.requestRemoveProject(project.cwd, project.name),
			}}
			state={workspaceSidebarState}
			onError={showCommandError}
		/>
	);
}
