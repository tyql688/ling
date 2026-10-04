import type { OpenProjectInfo } from "@ling/contracts/project";
import type { SessionSummary } from "@ling/contracts/session";
import { toSessionRef } from "@ling/contracts/session-ref";
import type { ChangeReviewTarget } from "@renderer/features/review/change-review-target";
import { useCommandFeedback } from "@renderer/hooks/use-command-feedback";
import { useSetAtom } from "jotai";
import { updateReadingWorkspaceAtom, withFeatureTab } from "./reading-state";
import { useCallback, useMemo } from "react";
import { useWorkspaceOwner, workspacePanelAtom, workspaceSelectionAtom } from "./workspace-state";

export function useWorkspaceReviewActions() {
	const updateReading = useSetAtom(updateReadingWorkspaceAtom);
	const showCommandError = useCommandFeedback();
	const {
		activeSession,
		sessions,
		sessionController: { selectSession },
	} = useWorkspaceOwner(workspaceSelectionAtom);
	const workbenchPanel = useWorkspaceOwner(workspacePanelAtom);
	/** Opens Changes in the project's most recent session when the active session belongs to another project. */
	const handleShowProjectChanges = useCallback(
		(project: OpenProjectInfo) => {
			if (activeSession?.cwd === project.cwd) {
				workbenchPanel.openReview("workspace");
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
				update: (current) =>
					withFeatureTab(
						{ ...current, panel: { ...current.panel, reviewScope: "workspace", reviewFocusFile: null } },
						"changes",
					),
			});
			void selectSession(ref).catch(showCommandError);
		},
		[activeSession, selectSession, sessions, showCommandError, workbenchPanel, updateReading],
	);

	/** Transcript file links land in the Changes tab, which keeps the list beside the selected diff. */
	const openSessionFileReview = useCallback(
		(path: string): void => workbenchPanel.openReview("session", { focusFile: path }),
		[workbenchPanel],
	);

	const openTurnReview = useCallback(
		(turnId: string | null, path?: string): void =>
			workbenchPanel.openReview("turn", { turnId, ...(path === undefined ? {} : { focusFile: path }) }),
		[workbenchPanel],
	);

	const openReviewNavigator = useCallback(
		(target: ChangeReviewTarget): void =>
			workbenchPanel.openReview(target.scope, { turnId: target.turnId, focusFile: target.path }),
		[workbenchPanel],
	);

	return useMemo(
		() => ({ handleShowProjectChanges, openSessionFileReview, openTurnReview, openReviewNavigator }),
		[handleShowProjectChanges, openSessionFileReview, openTurnReview, openReviewNavigator],
	);
}
