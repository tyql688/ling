import { sameSessionRef, sessionKey, toSessionRef } from "@ling/contracts/session-ref";
import { useShellSidebar } from "@renderer/components/use-shell-sidebar";
import { useWorkbenchPanel, type WorkbenchPanelState } from "@renderer/components/workbench/use-workbench-panel";
import { sidebarProjectScopeAtom } from "@renderer/features/projects/state";
import { useSessionSeen } from "@renderer/features/sessions/use-session-seen";
import { archivedTranscriptsAtom } from "@renderer/features/sessions/archived-session-state";
import { sidebarCollapsedAtom } from "@renderer/features/workspace/sidebar-state";
import { useCommandFeedback } from "@renderer/hooks/use-command-feedback";
import { useAtom, useAtomValue, useStore } from "jotai";
import { useCallback, useEffect, useLayoutEffect, useMemo, type SetStateAction } from "react";
import type { ProjectController } from "../projects/use-projects";
import type { SessionController } from "../sessions/use-sessions";
import { useSessionNavigationHistory } from "./use-session-navigation-history";
import { useWorkspaceModelFeedback } from "./use-workspace-model-feedback";
import { useWorkspaceSidebarState } from "./use-workspace-sidebar-state";
import { useWorkspaceTabs } from "./use-workspace-tabs";
import { useWorkspaceSessionActions } from "./workspace-session-actions";
import {
	usePublishWorkspaceOwner,
	workspaceHistoryAtom,
	workspaceModelFeedbackAtom,
	workspacePanelAtom,
	workspaceSelectionAtom,
	workspaceSessionActionsAtom,
	workspaceSidebarAtom,
	workspaceTabsAtom,
} from "./workspace-state";

import { focusedTabGroupAtom, sessionPreviewAtom, sessionTabOrderAtom } from "./tab-state";
import { sessionWorkbenchesAtom, updateReadingWorkspaceAtom, useReadingWorkspace } from "./reading-state";
import { workspaceDialogAtom } from "./use-workspace-dialogs";

export interface WorkspaceShellProps {
	onOpenSettings: () => void;
	projectController: ProjectController;
	sessionController: SessionController;
	/** False while the settings shell covers the workspace: hidden views must not capture shortcuts or extension terminal input. */
	visible: boolean;
}
export function useWorkspaceRuntime({
	onOpenSettings,
	projectController,
	sessionController,
	visible,
}: WorkspaceShellProps) {
	const showCommandError = useCommandFeedback();
	const store = useStore();
	useEffect(
		() => () => {
			store.set(workspaceDialogAtom, null);
			store.set(sessionWorkbenchesAtom, new Map());
			store.set(focusedTabGroupAtom, "conversation");
			store.set(sessionPreviewAtom, null);
			store.set(sessionTabOrderAtom, []);
		},
		[store],
	);

	const { sessions, activeSessionRef, openingSessionKey, deselectSession } = sessionController;

	const { projects } = projectController;

	const activeSessionKey = activeSessionRef ? sessionKey(activeSessionRef) : null;

	const sessionRuntimeOpening = activeSessionKey !== null && activeSessionKey === openingSessionKey;

	const archivedTranscripts = useAtomValue(archivedTranscriptsAtom);
	// An archived session is read from its file and never binds a runtime. Withholding the runtime
	// ref keeps every session-bound surface — extension UI, dock, viewport reporting — unmounted
	// instead of each one failing its own request against a session Host has no runtime for.
	const archivedSession = activeSessionKey !== null && archivedTranscripts.has(activeSessionKey);
	const runtimeSessionRef = sessionRuntimeOpening || archivedSession ? null : activeSessionRef;

	const [sidebarCollapsed, setSidebarCollapsed] = useAtom(sidebarCollapsedAtom);

	const sidebarProjectScopeCwd = useAtomValue(sidebarProjectScopeAtom);

	const shellSidebar = useShellSidebar({
		dockedCollapsed: sidebarCollapsed,
		onDockedCollapsedChange: setSidebarCollapsed,
	});

	const workspaceSidebarState = useWorkspaceSidebarState();

	useLayoutEffect(() => {
		store.set(updateReadingWorkspaceAtom, { ref: activeSessionRef, update: (current) => ({ ...current }) });
	}, [activeSessionKey, activeSessionRef, store]);
	const [reading, setReading] = useReadingWorkspace(activeSessionRef);
	const setPanel = useCallback(
		(update: SetStateAction<WorkbenchPanelState>) =>
			setReading((current) => ({ ...current, panel: typeof update === "function" ? update(current.panel) : update })),
		[setReading],
	);
	const workbenchPanel = useWorkbenchPanel(reading.panel, setPanel);

	const workspaceModelFeedback = useWorkspaceModelFeedback(activeSessionKey);

	const sessionActions = useWorkspaceSessionActions({
		sessionController,
		activeSessionRef,
		showCommandError,
		deselectSession,
	});

	const { newConversationCwd } = sessionActions;

	const emptyStateCwd =
		newConversationCwd ??
		(sidebarProjectScopeCwd !== null && projects.some((project) => project.cwd === sidebarProjectScopeCwd)
			? sidebarProjectScopeCwd
			: null);

	const activeCwd = activeSessionRef?.cwd ?? null;

	const workspaceTabs = useWorkspaceTabs({
		sessionController,
		projects,
		showCommandError,
	});

	const { selectConversation } = workspaceTabs;

	const sidebarSessionController = useMemo<SessionController>(
		() => ({
			...sessionController,
			selectSession: selectConversation,
		}),
		[selectConversation, sessionController],
	);
	const sessionNavigation = useSessionNavigationHistory({
		sessions,
		activeSessionRef,
		onSelect: selectConversation,
		onError: showCommandError,
	});

	const activeSession = sessions.find((s) => sameSessionRef(toSessionRef(s), activeSessionRef));

	// Child sessions created by Pi extensions are read-only transcripts.
	const activeSessionIsChild = activeSession?.relation?.kind === "child";

	const activeParentSession =
		activeSession?.relation?.kind === "child"
			? sessions.find((s) => sameSessionRef(toSessionRef(s), activeSession?.relation?.parentRef ?? null))
			: undefined;

	const activeProject = activeSession ? projects.find((p) => p.cwd === activeSession.cwd) : undefined;

	useSessionSeen(sessions, activeSession);

	const workspaceSelection = useMemo(
		() => ({
			projectController,
			sessionController,
			visible,
			onOpenSettings,
			sessions,
			projects,
			activeSessionRef,
			activeSessionKey,
			runtimeSessionRef,
			sessionRuntimeOpening,
			activeCwd,
			activeSession,
			activeSessionIsChild,
			activeParentSession,
			activeProject,
			emptyStateCwd,
		}),
		[
			projectController,
			sessionController,
			visible,
			onOpenSettings,
			sessions,
			projects,
			activeSessionRef,
			activeSessionKey,
			runtimeSessionRef,
			sessionRuntimeOpening,
			activeCwd,
			activeSession,
			activeSessionIsChild,
			activeParentSession,
			activeProject,
			emptyStateCwd,
		],
	);
	usePublishWorkspaceOwner(workspaceSelectionAtom, workspaceSelection);

	const workspaceSidebar = useMemo(
		() => ({ shellSidebar, workspaceSidebarState, sidebarSessionController }),
		[shellSidebar, workspaceSidebarState, sidebarSessionController],
	);
	usePublishWorkspaceOwner(workspaceSidebarAtom, workspaceSidebar);

	usePublishWorkspaceOwner(workspaceModelFeedbackAtom, workspaceModelFeedback);

	usePublishWorkspaceOwner(workspaceTabsAtom, workspaceTabs);
	usePublishWorkspaceOwner(workspacePanelAtom, workbenchPanel);
	usePublishWorkspaceOwner(workspaceSessionActionsAtom, sessionActions);
	usePublishWorkspaceOwner(workspaceHistoryAtom, sessionNavigation);

	return null;
}
