import type { OpenProjectInfo } from "@ling/contracts/project";
import type { SessionRef } from "@ling/contracts/session-ref";
import { atom, useAtom } from "jotai";
import { useCallback, useMemo } from "react";

interface NamedSessionTarget {
	ref: SessionRef;
	title: string;
}

interface NamedProjectTarget {
	cwd: string;
	name: string;
}

export interface WorkspaceDialogsController {
	pendingDelete: NamedSessionTarget | null;
	pendingRevertTurn: { ref: SessionRef; turnId: string } | null;
	pendingRemoveProject: NamedProjectTarget | null;
	pendingRemoveWorktree: OpenProjectInfo | null;
	worktreeProject: OpenProjectInfo | null;
	renameSessionTarget: NamedSessionTarget | null;
	requestDeleteSession(ref: SessionRef, title: string): void;
	requestRevertTurn(ref: SessionRef, turnId: string): void;
	requestRemoveProject(cwd: string, name: string): void;
	requestRemoveWorktree(project: OpenProjectInfo): void;
	openWorktree(project: OpenProjectInfo): void;
	openRenameSession(ref: SessionRef, title: string): void;
	closeDeleteSession(): void;
	closeRevertTurn(): void;
	closeRemoveProject(): void;
	closeRemoveWorktree(): void;
	closeWorktree(): void;
	closeRenameSession(): void;
}

type WorkspaceDialog =
	| { type: "deleteSession"; target: NamedSessionTarget }
	| { type: "revertTurn"; target: { ref: SessionRef; turnId: string } }
	| { type: "removeProject"; target: NamedProjectTarget }
	| { type: "removeWorktree"; target: OpenProjectInfo }
	| { type: "worktree"; target: OpenProjectInfo }
	| { type: "renameSession"; target: NamedSessionTarget };

/** Only one workspace dialog can own focus. Async completion cannot dismiss a newer target. */
export const workspaceDialogAtom = atom<WorkspaceDialog | null>(null);

export function useWorkspaceDialogs(): WorkspaceDialogsController {
	const [dialog, setDialog] = useAtom(workspaceDialogAtom);
	const dismiss = useCallback(
		(type: WorkspaceDialog["type"]) => {
			setDialog((current) => (current === dialog && current?.type === type ? null : current));
		},
		[dialog, setDialog],
	);
	return useMemo(
		() => ({
			pendingDelete: dialog?.type === "deleteSession" ? dialog.target : null,
			pendingRevertTurn: dialog?.type === "revertTurn" ? dialog.target : null,
			pendingRemoveProject: dialog?.type === "removeProject" ? dialog.target : null,
			pendingRemoveWorktree: dialog?.type === "removeWorktree" ? dialog.target : null,
			worktreeProject: dialog?.type === "worktree" ? dialog.target : null,
			renameSessionTarget: dialog?.type === "renameSession" ? dialog.target : null,
			requestDeleteSession: (ref, title) => setDialog({ type: "deleteSession", target: { ref, title } }),
			requestRevertTurn: (ref, turnId) => setDialog({ type: "revertTurn", target: { ref, turnId } }),
			requestRemoveProject: (cwd, name) => setDialog({ type: "removeProject", target: { cwd, name } }),
			requestRemoveWorktree: (target) => setDialog({ type: "removeWorktree", target }),
			openWorktree: (target) => setDialog({ type: "worktree", target }),
			openRenameSession: (ref, title) => setDialog({ type: "renameSession", target: { ref, title } }),
			closeDeleteSession: () => dismiss("deleteSession"),
			closeRevertTurn: () => dismiss("revertTurn"),
			closeRemoveProject: () => dismiss("removeProject"),
			closeRemoveWorktree: () => dismiss("removeWorktree"),
			closeWorktree: () => dismiss("worktree"),
			closeRenameSession: () => dismiss("renameSession"),
		}),
		[dialog, dismiss, setDialog],
	);
}
