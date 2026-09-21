import { PanelBoundary } from "@renderer/components/error-fallback";
import { BackgroundTasksPage } from "@renderer/features/background-tasks/background-tasks-page";
import { TodoPage } from "@renderer/features/pi-adapters/todo/todo-page";
import { QuestionsPage } from "@renderer/features/questions/questions-page";
import { LoadingTransition } from "@renderer/components/ui/loading-transition";
import { WorkbenchSlotHost } from "@renderer/components/workbench/workbench-slot-host";
import { SessionExtensionOverlay } from "@renderer/features/chat/extension-ui/session-extension-surfaces";
import type { FileReadingView } from "@renderer/features/files/use-file-preview-pane";
import { WorkspaceFilePreview } from "@renderer/features/files/workspace-file-preview";
import { ChangeReviewDetailTab } from "@renderer/features/review/change-review-detail-tab";
import { useReviewWorkspace } from "@renderer/features/review/use-review-workspace";
import { SkillReadingView } from "@renderer/features/skills/skill-reading-view";
import { sessionTranscriptStateFamily } from "@renderer/features/sessions/state/session";
import { TerminalWorkspace } from "@renderer/features/terminal/terminal-workspace";
import { atom, useAtomValue, useSetAtom } from "jotai";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { explorerRefreshRevisions } from "../files/explorer-revisions";
import { useReadingWorkspace } from "./reading-state";
import { focusedTabGroupAtom } from "./tab-state";
import { WorkspaceBanners } from "./workspace-banners";
import { WorkspaceShortcuts } from "./workspace-shortcuts";
import { archivedTranscriptsAtom } from "@renderer/features/sessions/archived-session-state";
import { WorkspaceChrome, WorkspaceReadingStrip } from "./workspace-heading";
import { useWorkspaceFileActions } from "./workspace-file-actions";
import { WorkspacePanel } from "./workspace-panel";
import { useWorkspaceReviewActions } from "./workspace-review-actions";
import { WorkspaceSessionConversation } from "./workspace-session-conversation";
import {
	useWorkspaceField,
	useWorkspaceOwner,
	workspacePanelAtom,
	workspaceSelectionAtom,
	workspaceTabsAtom,
} from "./workspace-state";
export function WorkspaceSessionStage() {
	const activeSessionRef = useWorkspaceField(workspaceSelectionAtom, "activeSessionRef");
	const activeSessionKey = useWorkspaceField(workspaceSelectionAtom, "activeSessionKey");
	const runtimeSessionRef = useWorkspaceField(workspaceSelectionAtom, "runtimeSessionRef");
	const sessionRuntimeOpening = useWorkspaceField(workspaceSelectionAtom, "sessionRuntimeOpening");
	const { copyProjectPath, revealProjectEntry, handleInsertProjectFileReference } = useWorkspaceFileActions();
	const { openReviewNavigator } = useWorkspaceReviewActions();
	const { activeViewer, openViewer } = useWorkspaceOwner(workspaceTabsAtom);
	const [reading, setReading] = useReadingWorkspace(activeSessionRef);
	const archivedTranscripts = useAtomValue(archivedTranscriptsAtom);
	const archived = activeSessionKey !== null && archivedTranscripts.has(activeSessionKey);
	const [terminalHeight, setTerminalHeight] = useState(0);
	const setFocusedGroup = useSetAtom(focusedTabGroupAtom);
	const activeViewerKey = activeViewer?.key;
	const updateFileView = useCallback(
		(view: Partial<FileReadingView>) =>
			setReading((current) => ({
				...current,
				tabs: current.tabs.map((tab) =>
					tab.key === activeViewerKey && tab.kind === "file"
						? {
								...tab,
								view: {
									mode: /\.(md|markdown|mdx)$/i.test(tab.path) ? "rendered" : "source",
									scrollTop: 0,
									...tab.view,
									...view,
								},
							}
						: tab,
				),
			})),
		[activeViewerKey, setReading],
	);
	const workbenchPanel = useWorkspaceOwner(workspacePanelAtom);
	const { t } = useTranslation();

	const { review: changeReview, files: changedFiles, refresh: refreshChanges } = useReviewWorkspace();
	const hydrationAtom = useMemo(
		() => atom((get) => get(sessionTranscriptStateFamily(activeSessionKey ?? "")).hydrationSettled),
		[activeSessionKey],
	);
	const hydrationSettled = useAtomValue(hydrationAtom);
	const conversationReady = !sessionRuntimeOpening && hydrationSettled;

	const workspaceExplorerRevisions = useMemo(
		() => explorerRefreshRevisions(changeReview.snapshot?.scopes.workspace.files ?? [], changedFiles.files),
		[changeReview.snapshot, changedFiles.files],
	);

	if (!activeSessionRef) return null;
	const viewer =
		activeViewer?.kind === "feature" ? (
			<PanelBoundary key={`${activeSessionKey}:${activeViewer.key}`}>
				{activeViewer.id === "todo" && <TodoPage sessionRef={activeSessionRef} />}
				{activeViewer.id === "questions" && <QuestionsPage sessionRef={activeSessionRef} />}
				{activeViewer.id === "background-tasks" && <BackgroundTasksPage sessionRef={activeSessionRef} />}
			</PanelBoundary>
		) : activeViewer?.kind === "file" ? (
			<PanelBoundary resetKeys={[activeViewer.key, workspaceExplorerRevisions.preview]}>
				<WorkspaceFilePreview
					cwd={activeViewer.cwd}
					path={activeViewer.path}
					viewKey={activeSessionKey!}
					view={activeViewer.view}
					onViewChange={updateFileView}
					onOpenFile={openViewer}
					refreshRevision={workspaceExplorerRevisions.preview}
					onCopyPath={copyProjectPath}
					onInsertReference={handleInsertProjectFileReference}
					onRevealEntry={revealProjectEntry}
				/>
			</PanelBoundary>
		) : activeViewer?.kind === "skill" ? (
			<PanelBoundary resetKeys={[activeViewer.key]}>
				<SkillReadingView
					key={`${activeSessionKey}:${activeViewer.key}`}
					skill={activeViewer.skill}
					view={activeViewer.view}
					onViewChange={(view) =>
						setReading((current) => ({
							...current,
							tabs: current.tabs.map((tab) => (tab === activeViewer ? { ...tab, view } : tab)),
						}))
					}
				/>
			</PanelBoundary>
		) : activeViewer?.kind === "review" && runtimeSessionRef ? (
			<PanelBoundary resetKeys={[activeViewer.key, changeReview.snapshot?.snapshotId]}>
				<ChangeReviewDetailTab
					key={activeViewer.key}
					sessionRef={runtimeSessionRef}
					target={activeViewer}
					snapshot={changeReview.snapshot}
					loading={changeReview.loading}
					error={changeReview.error}
					stateRecoveryError={changeReview.stateRecoveryError}
					scrollPosition={{
						top: activeViewer.scrollTop ?? 0,
						save: (scrollTop) =>
							setReading((current) => ({
								...current,
								tabs: current.tabs.map((tab) =>
									tab.key === activeViewer.key && tab.kind === "review" ? { ...tab, scrollTop } : tab,
								),
							})),
					}}
					onOpenNavigator={() => openReviewNavigator(activeViewer)}
					onRefresh={refreshChanges}
					onCopyPath={copyProjectPath}
				/>
			</PanelBoundary>
		) : null;
	return (
		<WorkbenchSlotHost
			chrome={<WorkspaceChrome />}
			readingHeader={<WorkspaceReadingStrip />}
			onSideClose={workbenchPanel.close}
			onSideToggle={workbenchPanel.toggleSidePanel}
			shortcuts={<WorkspaceShortcuts />}
			onConversationFocus={() => setFocusedGroup("conversation")}
			onReadingFocus={() => setFocusedGroup("reading")}
			expanded={reading.expanded}
			rightOpen={workbenchPanel.open}
			terminalHeight={reading.terminalOpen ? terminalHeight : 0}
			top={<WorkspaceBanners />}
			main={
				<div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
					{!sessionRuntimeOpening && <WorkspaceSessionConversation />}
					{!conversationReady && !archived && (
						<LoadingTransition
							label={t("session.loadingTranscript")}
							size="lg"
							className="pointer-events-none absolute inset-0 min-h-0 bg-loading-veil px-6"
						/>
					)}
				</div>
			}
			reading={viewer}
			bottom={(content) => (
				<TerminalWorkspace
					cwd={activeSessionRef.cwd}
					open={reading.terminalOpen}
					onOpenChange={(open) => setReading((current) => ({ ...current, terminalOpen: open }))}
					onHeightChange={setTerminalHeight}
				>
					{content}
				</TerminalWorkspace>
			)}
			side={workbenchPanel.sideMode === null ? null : <WorkspacePanel />}
			overlay={runtimeSessionRef ? <SessionExtensionOverlay sessionRef={runtimeSessionRef} /> : null}
		/>
	);
}
