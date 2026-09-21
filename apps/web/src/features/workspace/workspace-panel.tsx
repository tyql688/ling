import { PanelBoundary } from "@renderer/components/error-fallback";
import type { WorkbenchSidePanelMode } from "@renderer/components/workbench/use-workbench-panel";
import { SessionExtensionDock } from "@renderer/features/chat/extension-ui/session-extension-surfaces";
import { useSessionExtensionMeta } from "@renderer/features/chat/extension-ui/use-session-extension-meta";
import { WorkspaceExplorerPanel } from "@renderer/features/files/workspace-explorer-panel";
import { EditorOutline } from "@renderer/features/files/editor-outline";
import { ProjectPiConfigPanel } from "@renderer/features/projects/project-pi-config-panel";
import { ChangeReviewPanel } from "@renderer/features/review/change-review-panel";
import { ProjectSkillsPanel } from "@renderer/features/skills/project-skills-panel";
import { BranchPicker } from "@renderer/features/review/branch-picker";
import { useReviewWorkspace } from "@renderer/features/review/use-review-workspace";
import { useCommandFeedback } from "@renderer/hooks/use-command-feedback";
import { Blocks, FileCog, Files, GitCompareArrows, GraduationCap, PanelsTopLeft } from "lucide-react";
import { useCallback, useMemo, type ReactNode, type SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import { explorerRefreshRevisions } from "../files/explorer-revisions";
import { useWorkspaceFileActions } from "./workspace-file-actions";
import { useReadingWorkspace } from "./reading-state";
import type { WorkspaceExplorerNavigation } from "@renderer/features/files/use-workspace-explorer";
import { WorkspaceSidePanel } from "./workspace-side-panel";
import { WorkspaceToolPicker } from "./workspace-tool-picker";
import {
	useWorkspaceField,
	useWorkspaceOwner,
	workspacePanelAtom,
	workspaceSelectionAtom,
	workspaceTabsAtom,
} from "./workspace-state";
export function WorkspacePanel() {
	const activeSessionRef = useWorkspaceField(workspaceSelectionAtom, "activeSessionRef");
	const activeSessionKey = useWorkspaceField(workspaceSelectionAtom, "activeSessionKey");
	const runtimeSessionRef = useWorkspaceField(workspaceSelectionAtom, "runtimeSessionRef");
	const activeCwd = useWorkspaceField(workspaceSelectionAtom, "activeCwd");
	const activeProject = useWorkspaceField(workspaceSelectionAtom, "activeProject");
	const { copyProjectPath, handleInsertProjectFileReference } = useWorkspaceFileActions();
	const { activeReviewTarget, openViewer, openReviewViewer, openSkillViewer } = useWorkspaceOwner(workspaceTabsAtom);
	const [reading, setReading] = useReadingWorkspace(activeSessionRef);
	const setExplorerNavigation = useCallback(
		(update: SetStateAction<WorkspaceExplorerNavigation>) =>
			setReading((current) => ({
				...current,
				explorer: typeof update === "function" ? update(current.explorer) : update,
			})),
		[setReading],
	);
	const workbenchPanel = useWorkspaceOwner(workspacePanelAtom);
	const { t } = useTranslation();
	const showCommandError = useCommandFeedback();

	const { review: changeReview, files: changedFiles, refresh: refreshChanges } = useReviewWorkspace();
	const { dockItems: extensionDockItemCount } = useSessionExtensionMeta(runtimeSessionRef);

	const workspaceExplorerRevisions = useMemo(
		() => explorerRefreshRevisions(changeReview.snapshot?.scopes.workspace.files ?? [], changedFiles.files),
		[changeReview.snapshot, changedFiles.files],
	);
	const workspaceChangeCount = changeReview.snapshot?.scopes.workspace.count ?? changedFiles.files.length;
	const sidePanelTitles: Record<WorkbenchSidePanelMode, { label: string; icon: ReactNode; count?: number }> = {
		picker: { label: t("nav.sidePanel"), icon: <PanelsTopLeft aria-hidden="true" /> },
		explorer: { label: t("explorer.title"), icon: <Files aria-hidden="true" /> },
		review: {
			label: t("changes.toolbarLabel"),
			icon: <GitCompareArrows aria-hidden="true" />,
			count: workspaceChangeCount,
		},
		piConfig: { label: t("projectPiConfig.toolbarLabel"), icon: <FileCog aria-hidden="true" /> },
		skills: { label: t("skills.title"), icon: <GraduationCap aria-hidden="true" /> },
		dock: { label: t("extensionUi.dockTitle"), icon: <Blocks aria-hidden="true" />, count: extensionDockItemCount },
	};
	// The presence owner retains this view during its exit; keep the last tool painted until it unmounts.
	const sideMode = activeSessionRef ? (workbenchPanel.sideMode ?? workbenchPanel.lastSideMode) : null;
	const heading = sideMode === null ? sidePanelTitles.picker : sidePanelTitles[sideMode];
	return (
		<WorkspaceSidePanel
			title={heading.label}
			actions={
				sideMode === "review" && activeCwd ? (
					<BranchPicker
						cwd={activeCwd}
						open={workbenchPanel.historyOpen}
						onOpenChange={workbenchPanel.setHistoryOpen}
						onChanged={refreshChanges}
						onError={showCommandError}
					/>
				) : null
			}
		>
			{sideMode === "picker" && <WorkspaceToolPicker />}
			{sideMode === "explorer" && activeSessionRef && (
				<>
					<WorkspaceExplorerPanel
						key={activeSessionKey}
						navigation={reading.explorer}
						onNavigationChange={setExplorerNavigation}
						cwd={activeSessionRef.cwd}
						projectName={activeProject?.name}
						open
						changedFiles={changedFiles.files}
						treeRefreshRevision={workspaceExplorerRevisions.tree}
						focusFile={workbenchPanel.explorerFocus}
						onFocusFileHandled={workbenchPanel.clearExplorerFocus}
						onInsertReference={handleInsertProjectFileReference}
						onRefreshWorkspace={refreshChanges}
						onOpenFile={openViewer}
					/>
					<EditorOutline viewKey={activeSessionKey!} />
				</>
			)}
			{sideMode === "piConfig" && activeCwd && (
				<PanelBoundary resetKeys={[activeCwd]}>
					<ProjectPiConfigPanel
						docked
						cwd={activeCwd}
						open
						onOpenChange={(open) => {
							if (!open) workbenchPanel.close();
						}}
					/>
				</PanelBoundary>
			)}
			{sideMode === "skills" && activeProject && activeSessionRef && (
				<PanelBoundary resetKeys={[activeProject.cwd, activeSessionKey]}>
					<ProjectSkillsPanel key={activeSessionKey} session={activeSessionRef} onOpenSkill={openSkillViewer} />
				</PanelBoundary>
			)}
			{sideMode === "review" && runtimeSessionRef && (
				<PanelBoundary resetKeys={[activeSessionKey]}>
					<ChangeReviewPanel
						key={activeSessionKey}
						docked
						sessionRef={runtimeSessionRef}
						open
						focusFile={workbenchPanel.reviewFocusFile}
						onFocusFileHandled={workbenchPanel.clearReviewFocusFile}
						requestedScope={workbenchPanel.reviewScope}
						onScopeChange={(reviewScope) =>
							setReading((current) => ({ ...current, panel: { ...current.panel, reviewScope } }))
						}
						requestedTurnId={workbenchPanel.reviewTurnId}
						snapshot={changeReview.snapshot}
						loading={changeReview.loading}
						error={changeReview.error}
						stateRecoveryError={changeReview.stateRecoveryError}
						onOpenChange={workbenchPanel.setReviewOpen}
						onRefresh={refreshChanges}
						onCopyPath={copyProjectPath}
						activeTarget={activeReviewTarget}
						onOpenFile={openReviewViewer}
					/>
				</PanelBoundary>
			)}

			{sideMode === "dock" && runtimeSessionRef && (
				<SessionExtensionDock key={activeSessionKey} sessionRef={runtimeSessionRef} onClose={workbenchPanel.close} />
			)}
		</WorkspaceSidePanel>
	);
}
