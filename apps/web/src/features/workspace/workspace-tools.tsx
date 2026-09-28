import { TooltipIconButton } from "@renderer/components/ui/tooltip-icon-button";
import { useWorkbenchLayout } from "@renderer/components/workbench/workbench-layout-context";
import { shortcut } from "@renderer/lib/platform";
import { cn } from "@renderer/lib/utils";
import { Maximize2, Minimize2, PanelRightOpen } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useReadingWorkspace } from "./reading-state";
import { useWorkspaceField, workspaceSelectionAtom } from "./workspace-state";

/** Reading controls stay beside the reading tabs when the column is visible. */
export function WorkspacePanelActions() {
	const { t } = useTranslation();
	const activeSessionRef = useWorkspaceField(workspaceSelectionAtom, "activeSessionRef");
	const { sideVisible, toggleSidePanel, hasReading, compact, floating } = useWorkbenchLayout();
	const [, setReading] = useReadingWorkspace(activeSessionRef);
	return (
		<>
			{hasReading && (
				<TooltipIconButton
					label={t(floating ? "reading.restoreConversation" : "reading.expand")}
					disabled={compact}
					aria-pressed={floating}
					onClick={() => setReading((current) => ({ ...current, expanded: !current.expanded }))}
					className="disabled:opacity-35"
				>
					{floating ? (
						<Minimize2 className="size-4" aria-hidden="true" />
					) : (
						<Maximize2 className="size-4" aria-hidden="true" />
					)}
				</TooltipIconButton>
			)}
			<TooltipIconButton
				disabled={activeSessionRef === null}
				onClick={toggleSidePanel}
				data-workspace-side-trigger=""
				label={t(!sideVisible ? "nav.openSidePanel" : "nav.closeSidePanel")}
				aria-pressed={sideVisible}
				shortcut={shortcut("J")}
				className={cn(sideVisible && "bg-surface-hover text-text-primary")}
			>
				<PanelRightOpen className="size-4" aria-hidden="true" />
			</TooltipIconButton>
		</>
	);
}
