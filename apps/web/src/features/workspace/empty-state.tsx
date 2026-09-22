import { Button } from "@renderer/components/ui/button";
import { EmptyState as EmptyStateView } from "@renderer/components/ui/empty-state";
import { useCommandFeedback } from "@renderer/hooks/use-command-feedback";
import { FolderPlus } from "lucide-react";
import type { OpenProjectInfo } from "@ling/contracts/project";
import { useTranslation } from "react-i18next";
import { QuickStartComposer } from "./quick-start-composer";
import type { QuickStartOptions } from "./use-quick-start-composer";
import {
	useWorkspaceField,
	useWorkspaceOwner,
	workspaceSelectionAtom,
	workspaceSessionActionsAtom,
} from "./workspace-state";

/** Time-based greeting: the hero line follows the local clock. */
function greetingSlot(): "morning" | "afternoon" | "evening" | "night" {
	const hour = new Date().getHours();
	if (hour >= 5 && hour < 12) return "morning";
	if (hour >= 12 && hour < 18) return "afternoon";
	if (hour >= 18 && hour < 23) return "evening";
	return "night";
}

function EmptyState({
	projects,
	preferredCwd,
	onAddProject,
	onQuickStart,
}: {
	projects: OpenProjectInfo[];
	preferredCwd: string | null;
	onAddProject: () => Promise<OpenProjectInfo | null>;
	onQuickStart: (text: string, options: QuickStartOptions) => Promise<void>;
}) {
	const { t } = useTranslation();
	const onError = useCommandFeedback();
	if (projects.length === 0)
		return (
			<div className="relative flex flex-1 items-center justify-center">
				<EmptyStateView
					variant="first-run"
					className="relative"
					icon={FolderPlus}
					title={t("session.addProjectTitle")}
					description={t("session.addProjectDescription")}
					action={<Button onClick={() => void onAddProject().catch(onError)}>{t("project.add")}</Button>}
				/>
			</div>
		);
	return (
		<div className="relative flex min-h-0 flex-1 flex-col items-center justify-center-safe gap-5 overflow-y-auto overscroll-contain px-6 py-6">
			<h1 className="welcome-greeting relative max-w-lg shrink-0 text-center font-serif text-xl text-text-primary">
				{t(`session.emptyGreeting_${greetingSlot()}`)}
			</h1>
			<QuickStartComposer
				projects={projects}
				preferredCwd={preferredCwd}
				onAddProject={onAddProject}
				onQuickStart={onQuickStart}
			/>
		</div>
	);
}

export function WorkspaceHome() {
	const projectController = useWorkspaceField(workspaceSelectionAtom, "projectController");
	const projects = useWorkspaceField(workspaceSelectionAtom, "projects");
	const emptyStateCwd = useWorkspaceField(workspaceSelectionAtom, "emptyStateCwd");
	const sessionActions = useWorkspaceOwner(workspaceSessionActionsAtom);

	const { addProject } = projectController;
	const { handleHomeStart } = sessionActions;
	return (
		<EmptyState
			key={emptyStateCwd ?? "global"}
			projects={projects}
			preferredCwd={emptyStateCwd}
			onAddProject={addProject}
			onQuickStart={handleHomeStart}
		/>
	);
}
