import { useDomainApi } from "@renderer/lib/host-api-context";
import type { CreateWorktreeRequest } from "@ling/contracts/git";
import type { SessionRef } from "@ling/contracts/session-ref";
import { ConfirmDialog } from "@renderer/components/ui/confirm-dialog";
import { useReviewWorkspace } from "@renderer/features/review/use-review-workspace";
import { WorktreeDialog } from "@renderer/features/review/worktree-dialog";
import { useCommandFeedback } from "@renderer/hooks/use-command-feedback";
import { useTranslation } from "react-i18next";
import { RenameSessionDialog } from "../sessions/rename-session-dialog";
import type { WorkspaceDialogsController } from "./use-workspace-dialogs";
import { useWorkspaceDialogs } from "./use-workspace-dialogs";
import {
	useWorkspaceField,
	useWorkspaceOwner,
	workspaceSelectionAtom,
	workspaceSessionActionsAtom,
	workspaceTabsAtom,
} from "./workspace-state";

interface WorkspaceDialogsProps {
	controller: WorkspaceDialogsController;
	deleteSession: (ref: SessionRef) => Promise<void>;
	removeProject: (cwd: string) => Promise<unknown>;
	removeWorktree: (request: { rootCwd: string; worktreePath: string }) => Promise<unknown>;
	createWorktree: (request: CreateWorktreeRequest) => Promise<unknown>;
	renameSession: (ref: SessionRef, title: string) => Promise<void>;
	refreshChangedFiles: () => void;
	refreshChangeReview: () => Promise<unknown>;
	onError: (error: unknown) => void;
}

function WorkspaceDialogs({
	controller,
	deleteSession,
	removeProject,
	removeWorktree,
	createWorktree,
	renameSession,
	refreshChangedFiles,
	refreshChangeReview,
	onError,
}: WorkspaceDialogsProps) {
	const hostChangeReviewApi = useDomainApi("changeReview");

	const { t } = useTranslation();

	return (
		<>
			<ConfirmDialog
				open={controller.pendingRevertTurn !== null}
				title={t("changes.revertTurnConfirm")}
				confirmLabel={t("changes.revertTurnAction")}
				cancelLabel={t("session.cancel")}
				destructive
				onConfirm={() => {
					const target = controller.pendingRevertTurn;
					controller.closeRevertTurn();
					if (target === null) return;
					void hostChangeReviewApi
						.revertTurn(target)
						.then(() => {
							refreshChangedFiles();
							return refreshChangeReview();
						})
						.catch(onError);
				}}
				onCancel={controller.closeRevertTurn}
			/>
			<ConfirmDialog
				open={controller.pendingDelete !== null}
				title={controller.pendingDelete ? t("session.confirmDelete", { title: controller.pendingDelete.title }) : ""}
				confirmLabel={t("session.ctxDelete")}
				cancelLabel={t("session.cancel")}
				destructive
				onConfirm={() => {
					const target = controller.pendingDelete;
					if (target === null) return;
					void deleteSession(target.ref).then(controller.closeDeleteSession).catch(onError);
				}}
				onCancel={controller.closeDeleteSession}
			/>
			<ConfirmDialog
				open={controller.pendingRemoveProject !== null}
				title={
					controller.pendingRemoveProject
						? t("project.confirmRemove", { name: controller.pendingRemoveProject.name })
						: ""
				}
				confirmLabel={t("project.remove")}
				cancelLabel={t("session.cancel")}
				destructive
				onConfirm={() => {
					const target = controller.pendingRemoveProject;
					if (target === null) return;
					void removeProject(target.cwd).then(controller.closeRemoveProject).catch(onError);
				}}
				onCancel={controller.closeRemoveProject}
			/>
			<ConfirmDialog
				open={controller.pendingRemoveWorktree !== null}
				title={
					controller.pendingRemoveWorktree
						? t("worktree.confirmRemove", { name: controller.pendingRemoveWorktree.name })
						: ""
				}
				confirmLabel={t("worktree.remove")}
				cancelLabel={t("session.cancel")}
				destructive
				onConfirm={() => {
					const target = controller.pendingRemoveWorktree;
					if (target === null) return;
					const rootCwd =
						target.meta.kind === "worktree" && target.meta.rootWorkspacePath
							? target.meta.rootWorkspacePath
							: target.cwd;
					void removeWorktree({ rootCwd, worktreePath: target.cwd })
						.then(controller.closeRemoveWorktree)
						.catch(onError);
				}}
				onCancel={controller.closeRemoveWorktree}
			/>
			<WorktreeDialog
				open={controller.worktreeProject !== null}
				project={controller.worktreeProject}
				onOpenChange={(open) => {
					if (!open) controller.closeWorktree();
				}}
				onCreate={async (request) => {
					await createWorktree(request);
				}}
			/>
			<RenameSessionDialog
				target={controller.renameSessionTarget}
				onClose={controller.closeRenameSession}
				onRename={renameSession}
			/>
		</>
	);
}

export function WorkspaceDialogHost() {
	const projectController = useWorkspaceField(workspaceSelectionAtom, "projectController");
	const showCommandError = useCommandFeedback();
	const { deleteSessionAndTab } = useWorkspaceOwner(workspaceTabsAtom);
	const dialogs = useWorkspaceDialogs();
	const sessionActions = useWorkspaceOwner(workspaceSessionActionsAtom);

	const { files: changedFiles, review: changeReview } = useReviewWorkspace();
	const { removeProject, removeWorktree, createWorktree } = projectController;
	const { handleRenameSession } = sessionActions;
	return (
		<WorkspaceDialogs
			controller={dialogs}
			deleteSession={deleteSessionAndTab}
			removeProject={removeProject}
			removeWorktree={removeWorktree}
			createWorktree={createWorktree}
			renameSession={handleRenameSession}
			refreshChangedFiles={changedFiles.refresh}
			refreshChangeReview={changeReview.refresh}
			onError={showCommandError}
		/>
	);
}
