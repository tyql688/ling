import { sessionKey } from "@ling/contracts/session-ref";
import { Button } from "@renderer/components/ui/button";
import { FeedbackNotice } from "@renderer/components/ui/feedback";
import { VerticalReveal } from "@renderer/components/ui/vertical-reveal";
import { sessionErrorMessageFamily } from "@renderer/features/sessions/state/session";
import { useAtomValue } from "jotai";
import { useTranslation } from "react-i18next";
import { useWorkspaceField, workspaceSelectionAtom } from "./workspace-state";
export function WorkspaceBanners() {
	const sessionController = useWorkspaceField(workspaceSelectionAtom, "sessionController");
	const projectController = useWorkspaceField(workspaceSelectionAtom, "projectController");
	const runtimeSessionRef = useWorkspaceField(workspaceSelectionAtom, "runtimeSessionRef");
	const { t } = useTranslation();
	const { error: sessionsError } = sessionController;
	const { storeRetrying, retryProjectStore, error: projectsError, warning: projectsWarning } = projectController;
	const chatError = useAtomValue(sessionErrorMessageFamily(runtimeSessionRef ? sessionKey(runtimeSessionRef) : ""));

	// Change-review failures render beside the changed-file surface, where refresh is
	// actionable. Repeating them in this global strip produced two persistent copies.
	const shellError = chatError ?? sessionsError ?? projectsError;

	const stageBanners = (
		<>
			<VerticalReveal show={Boolean(shellError)}>
				{shellError && (
					<div className="border-border-subtle border-b px-4 py-2">
						<FeedbackNotice tone="danger" className="rounded-control px-3 py-2 text-xs">
							{shellError}
						</FeedbackNotice>
					</div>
				)}
			</VerticalReveal>
			<VerticalReveal show={Boolean(projectsWarning)}>
				{projectsWarning && (
					<div className="border-border-subtle border-b px-4 py-2">
						<FeedbackNotice
							tone="warning"
							className="rounded-control px-3 py-2 text-xs"
							action={
								<Button size="sm" variant="outline" disabled={storeRetrying} onClick={() => void retryProjectStore()}>
									{t("project.loadRetry")}
								</Button>
							}
						>
							{projectsWarning}
						</FeedbackNotice>
					</div>
				)}
			</VerticalReveal>
		</>
	);
	return stageBanners;
}
