import { useDomainApi } from "@renderer/lib/host-api-context";
import { sameSessionRef, type SessionRef, toSessionRef } from "@ling/contracts/session-ref";
import { useCommandFeedback } from "@renderer/hooks/use-command-feedback";
import { useCallback, useMemo } from "react";
import type { SessionActionsMenuModel } from "../sessions/session-actions-menu";
import { useWorkspaceDialogs } from "./use-workspace-dialogs";
import {
	useWorkspaceField,
	useWorkspaceOwner,
	workspaceSelectionAtom,
	workspaceSessionActionsAtom,
} from "./workspace-state";

export function useWorkspaceSessionMenus() {
	const hostSessionApi = useDomainApi("session");
	const hostProjectApi = useDomainApi("project");

	const showCommandError = useCommandFeedback();
	const sessions = useWorkspaceField(workspaceSelectionAtom, "sessions");
	const activeSessionRef = useWorkspaceField(workspaceSelectionAtom, "activeSessionRef");
	const sessionController = useWorkspaceField(workspaceSelectionAtom, "sessionController");
	const dialogs = useWorkspaceDialogs();
	const { handleForkWhole, handleNewConversation, handleCompact } = useWorkspaceOwner(workspaceSessionActionsAtom);
	/** Active-session compaction uses the visible conversation action; other tabs address Host directly. */
	const tabSessionMenu = useCallback(
		(ref: SessionRef): SessionActionsMenuModel | undefined => {
			const summary = sessions.find((session) => sameSessionRef(toSessionRef(session), ref));
			if (summary === undefined) return undefined;
			const summaryRef = toSessionRef(summary);
			return {
				session: {
					id: summary.id,
					cwd: summary.cwd,
					pinned: summary.pinnedAt !== undefined,
					archived: summary.archivedAt !== undefined,
				},
				handlers: {
					onRename: () => dialogs.openRenameSession(summaryRef, summary.title),
					onPin: (pinned) => void sessionController.setSessionPinned(summaryRef, pinned).catch(showCommandError),
					onArchive: (archived) =>
						void sessionController.setSessionArchived(summaryRef, archived).catch(showCommandError),
					onFork: () => void handleForkWhole(summaryRef).catch(showCommandError),
					onCompact:
						summary.relation?.kind === "child"
							? undefined
							: sameSessionRef(ref, activeSessionRef)
								? () => void handleCompact()
								: () => void hostSessionApi.compact({ ref: summaryRef }).catch(showCommandError),
					onReveal: () =>
						void hostProjectApi.launchDefault({ cwd: summary.cwd, kind: "file-manager" }).catch(showCommandError),
					onDelete: () => dialogs.requestDeleteSession(summaryRef, summary.title),
				},
			};
		},
		[
			hostSessionApi,
			hostProjectApi,
			dialogs,
			handleForkWhole,
			handleCompact,
			activeSessionRef,
			sessionController,
			sessions,
			showCommandError,
		],
	);

	return useMemo(
		() => ({ tabSessionMenu, startNewConversation: handleNewConversation }),
		[tabSessionMenu, handleNewConversation],
	);
}
