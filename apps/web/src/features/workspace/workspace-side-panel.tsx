import type { ReactNode } from "react";
import { WorkspaceToolSelector } from "./workspace-tools";
import { useWorkbenchLayout } from "@renderer/components/workbench/workbench-layout-context";
import { TooltipIconButton } from "@renderer/components/ui/tooltip-icon-button";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";

export function WorkspaceSidePanel({
	title,
	actions,
	children,
}: {
	title: string;
	actions?: ReactNode;
	children: ReactNode;
}) {
	const { compact, toggleSidePanel } = useWorkbenchLayout();
	const { t } = useTranslation();
	return (
		<aside
			data-workspace-side-panel=""
			aria-label={title}
			className="workspace-side-surface flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-workbench-side"
		>
			<div className="flex min-h-11 shrink-0 items-center gap-1 border-b border-border-subtle px-2">
				<div className="min-w-0 flex-1">
					<WorkspaceToolSelector title={title} />
				</div>
				{actions}
				{compact && (
					<TooltipIconButton label={t("nav.closeSidePanel")} onClick={toggleSidePanel}>
						<X className="size-4" />
					</TooltipIconButton>
				)}
			</div>
			<div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
		</aside>
	);
}
