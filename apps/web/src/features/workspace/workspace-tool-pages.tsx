import { PanelBoundary } from "@renderer/components/error-fallback";
import { EmptyState } from "@renderer/components/ui/empty-state";
import type { FeaturePageId } from "@renderer/components/workbench/feature-navigation";
import { BackgroundTasksPage } from "@renderer/features/background-tasks/background-tasks-page";
import { SessionExtensionDock } from "@renderer/features/chat/extension-ui/session-extension-surfaces";
import { TodoPage } from "@renderer/features/pi-adapters/todo/todo-page";
import { ProjectPiConfigPanel } from "@renderer/features/projects/project-pi-config-panel";
import { QuestionsPage } from "@renderer/features/questions/questions-page";
import { BranchPicker } from "@renderer/features/review/branch-picker";
import { ChangeReviewPanel } from "@renderer/features/review/change-review-panel";
import { useReviewWorkspace } from "@renderer/features/review/use-review-workspace";
import { ProjectSkillsPanel } from "@renderer/features/skills/project-skills-panel";
import { TerminalPanel } from "@renderer/features/terminal/terminal-panel";
import { useTerminals } from "@renderer/features/terminal/use-terminal-controller";
import { useCommandFeedback } from "@renderer/hooks/use-command-feedback";
import { Folder, FolderOpen } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useReadingWorkspace, featureTabKey } from "./reading-state";
import { useWorkspaceFileActions } from "./workspace-file-actions";
import { WorkspaceNewTab } from "./workspace-new-tab";
import {
	useWorkspaceField,
	useWorkspaceOwner,
	workspacePanelAtom,
	workspaceSelectionAtom,
	workspaceTabsAtom,
} from "./workspace-state";

/** One right-column tab per tool; every page is bound to the active session and its project. */
export function WorkspaceToolPage({ id }: { id: FeaturePageId }) {
	const { t } = useTranslation();
	const activeSessionRef = useWorkspaceField(workspaceSelectionAtom, "activeSessionRef");
	const activeSessionKey = useWorkspaceField(workspaceSelectionAtom, "activeSessionKey");
	const runtimeSessionRef = useWorkspaceField(workspaceSelectionAtom, "runtimeSessionRef");
	const { readingGroup } = useWorkspaceOwner(workspaceTabsAtom);
	const [reading, setReading] = useReadingWorkspace(activeSessionRef);
	if (activeSessionRef === null) return null;
	const close = () => readingGroup.close(featureTabKey(id));
	return (
		<PanelBoundary key={`${activeSessionKey}:${id}`} resetKeys={[activeSessionKey]}>
			{id === "files" && (
				<EmptyState
					icon={FolderOpen}
					title={t("explorer.selectFileTitle")}
					description={t("explorer.selectFileDescription")}
					className="flex-1"
				/>
			)}
			{id === "changes" && runtimeSessionRef && <WorkspaceChangesPage />}
			{id === "terminal" && <WorkspaceTerminalPage cwd={activeSessionRef.cwd} onClose={close} />}
			{id === "skills" && (
				<ProjectSkillsPanel
					session={activeSessionRef}
					selection={reading.skill}
					onSelectionChange={(skill) => setReading((current) => ({ ...current, skill }))}
					onScrollChange={(filePath, resourcePath, scrollTop) =>
						setReading((current) =>
							current.skill?.skill.filePath === filePath && current.skill.resourcePath === resourcePath
								? { ...current, skill: { ...current.skill, scrollTop } }
								: current,
						)
					}
				/>
			)}
			{id === "pi-config" && (
				<ProjectPiConfigPanel
					docked
					cwd={activeSessionRef.cwd}
					open
					onOpenChange={(open) => {
						if (!open) close();
					}}
				/>
			)}
			{id === "dock" && runtimeSessionRef && <SessionExtensionDock sessionRef={runtimeSessionRef} onClose={close} />}
			{id === "todo" && <TodoPage sessionRef={activeSessionRef} />}
			{id === "questions" && <QuestionsPage sessionRef={activeSessionRef} />}
			{id === "background-tasks" && <BackgroundTasksPage sessionRef={activeSessionRef} />}
			{id === "new-tab" && <WorkspaceNewTab />}
		</PanelBoundary>
	);
}

/** Terminals belong to the project; closing this tab hides them while their processes keep running. */
function WorkspaceTerminalPage({ cwd, onClose }: { cwd: string; onClose: () => void }) {
	const controller = useTerminals();
	const onError = useCommandFeedback();
	return (
		<PanelBoundary resetKeys={[cwd]}>
			<TerminalPanel
				cwd={cwd}
				open
				controller={controller}
				onOpenChange={(open) => {
					if (!open) onClose();
				}}
				onError={onError}
			/>
		</PanelBoundary>
	);
}

/** The project and branch lead the review header; the panel keeps its own scopes, list and diff. */
function WorkspaceChangesPage() {
	const activeSessionKey = useWorkspaceField(workspaceSelectionAtom, "activeSessionKey");
	const runtimeSessionRef = useWorkspaceField(workspaceSelectionAtom, "runtimeSessionRef");
	const activeProject = useWorkspaceField(workspaceSelectionAtom, "activeProject");
	const activeCwd = useWorkspaceField(workspaceSelectionAtom, "activeCwd");
	const workbenchPanel = useWorkspaceOwner(workspacePanelAtom);
	const { copyProjectPath } = useWorkspaceFileActions();
	const showCommandError = useCommandFeedback();
	const { review: changeReview, refresh: refreshChanges } = useReviewWorkspace();
	if (runtimeSessionRef === null || activeCwd === null) return null;
	return (
		<div className="flex min-h-0 min-w-0 flex-1 flex-col">
			<ChangeReviewPanel
				headerLeading={
					<div className="flex min-w-0 shrink items-center gap-2">
						<Folder className="size-3.5 shrink-0 text-text-muted" aria-hidden="true" />
						<span className="min-w-0 truncate text-ui font-medium text-text-primary">{activeProject?.name}</span>
						<BranchPicker
							cwd={activeCwd}
							open={workbenchPanel.historyOpen}
							onOpenChange={workbenchPanel.setHistoryOpen}
							onChanged={refreshChanges}
							onError={showCommandError}
						/>
					</div>
				}
				key={activeSessionKey}
				docked
				sessionRef={runtimeSessionRef}
				open
				focusFile={workbenchPanel.reviewFocusFile}
				onFocusFileHandled={workbenchPanel.clearReviewFocusFile}
				requestedScope={workbenchPanel.reviewScope}
				onScopeChange={workbenchPanel.setReviewScope}
				requestedTurnId={workbenchPanel.reviewTurnId}
				snapshot={changeReview.snapshot}
				loading={changeReview.loading}
				error={changeReview.error}
				stateRecoveryError={changeReview.stateRecoveryError}
				onOpenChange={(open) => {
					if (!open) workbenchPanel.closeReview();
				}}
				onRefresh={refreshChanges}
				onCopyPath={copyProjectPath}
			/>
		</div>
	);
}
