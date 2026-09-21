import type { OpenProjectInfo } from "@ling/contracts/project";
import type { SessionSummary } from "@ling/contracts/session";
import { toSessionRef } from "@ling/contracts/session-ref";
import type { ChangeReviewTarget } from "@renderer/features/review/change-review-target";
import { useCommandFeedback } from "@renderer/hooks/use-command-feedback";
import { useSetAtom } from "jotai";
import { updateReadingWorkspaceAtom } from "./reading-state";
import { useCallback, useMemo } from "react";
import { useWorkspaceOwner, workspacePanelAtom, workspaceSelectionAtom, workspaceTabsAtom } from "./workspace-state";

export function useWorkspaceReviewActions() {
	const updateReading = useSetAtom(updateReadingWorkspaceAtom);
	const showCommandError = useCommandFeedback();
	const {
		activeSession,
		sessions,
		sessionController: { selectSession },
	} = useWorkspaceOwner(workspaceSelectionAtom);
	const workbenchPanel = useWorkspaceOwner(workspacePanelAtom);
	const { openReviewViewer } = useWorkspaceOwner(workspaceTabsAtom);
	/** Project menu → "show changes": the panel is session-bound, so land on the project's most
	 * recent session first when it isn't already active. */
	const handleShowProjectChanges = useCallback(
		(project: OpenProjectInfo) => {
			if (activeSession?.cwd === project.cwd) {
				workbenchPanel.openReviewWorkspace();
				return;
			}
			const latest = sessions
				.filter((session) => session.cwd === project.cwd && session.relation?.kind !== "child")
				.reduce<SessionSummary | null>(
					(best, session) => (best === null || session.updatedAt > best.updatedAt ? session : best),
					null,
				);
			if (!latest) return;
			const ref = toSessionRef(latest);
			updateReading({
				ref,
				update: (current) => ({
					...current,
					panel: {
						...current.panel,
						sideMode: "review",
						lastSideMode: "review",
						reviewScope: "workspace",
						reviewFocusFile: null,
					},
				}),
			});
			void selectSession(ref).catch(showCommandError);
		},
		[activeSession, selectSession, sessions, showCommandError, workbenchPanel, updateReading],
	);

	const openSessionFileReview = useCallback(
		(path: string): void => {
			workbenchPanel.openReviewSession();
			openReviewViewer({ scope: "session", turnId: null, path });
		},
		[openReviewViewer, workbenchPanel],
	);

	const openTurnReview = useCallback(
		(turnId: string | null, path?: string): void => {
			workbenchPanel.openReviewTurn(turnId);
			if (path !== undefined) openReviewViewer({ scope: "turn", turnId, path });
		},
		[openReviewViewer, workbenchPanel],
	);

	const openReviewNavigator = useCallback(
		(target: ChangeReviewTarget): void => {
			switch (target.scope) {
				case "turn":
					workbenchPanel.openReviewTurn(target.turnId);
					break;
				case "session":
					workbenchPanel.openReviewSession();
					break;
				case "workspace":
					workbenchPanel.openReviewWorkspace();
					break;
				case "unpushed":
					workbenchPanel.openReviewUnpushed();
					break;
			}
		},
		[workbenchPanel],
	);

	return useMemo(
		() => ({ handleShowProjectChanges, openSessionFileReview, openTurnReview, openReviewNavigator }),
		[handleShowProjectChanges, openSessionFileReview, openTurnReview, openReviewNavigator],
	);
}
