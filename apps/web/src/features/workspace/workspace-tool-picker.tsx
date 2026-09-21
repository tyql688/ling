import { useWorkspaceOwner, workspacePanelAtom, workspaceSelectionAtom, workspaceTabsAtom } from "./workspace-state";
import { useWorkspaceField } from "./workspace-state";
import { useSessionExtensionMeta } from "@renderer/features/chat/extension-ui/use-session-extension-meta";
import { useReviewWorkspace } from "@renderer/features/review/use-review-workspace";
import { cn } from "@renderer/lib/utils";
import { ListTodo, MessageCircleQuestion, SquareTerminal, type LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { featurePageTitleKeys, type FeaturePageId } from "@renderer/components/workbench/feature-navigation";
import { builtinWorkspaceTools, formatWorkspaceToolCount } from "./workspace-tool-items";

const featurePages: [FeaturePageId, LucideIcon][] = [
	["todo", ListTodo],
	["questions", MessageCircleQuestion],
	["background-tasks", SquareTerminal],
];

/**
 * The side panel's opening state. Offering the tools costs one click but keeps the panel from
 * assuming a destination; the chosen tool is remembered, so only the first open lands here.
 */
export function WorkspaceToolPicker() {
	const { t } = useTranslation();
	const activeSessionRef = useWorkspaceField(workspaceSelectionAtom, "activeSessionRef");
	const runtimeSessionRef = useWorkspaceField(workspaceSelectionAtom, "runtimeSessionRef");
	const workbenchPanel = useWorkspaceOwner(workspacePanelAtom);
	const tabs = useWorkspaceOwner(workspaceTabsAtom);
	const { review: changeReview, files: changedFiles, refresh: refreshChanges } = useReviewWorkspace();
	const { dockItems: extensionDockItemCount } = useSessionExtensionMeta(runtimeSessionRef);
	const tools = builtinWorkspaceTools({
		t,
		disabled: activeSessionRef === null,
		explorer: { open: false, toggle: () => workbenchPanel.openSideMode("explorer") },
		review: {
			open: false,
			count: changeReview.snapshot?.scopes.workspace.count ?? changedFiles.files.length,
			error: changedFiles.error !== null,
			toggle: workbenchPanel.openReviewWorkspace,
			refresh: refreshChanges,
		},
		piConfig: { toggle: () => workbenchPanel.openSideMode("piConfig") },
		skills: activeSessionRef === null ? undefined : () => workbenchPanel.openSideMode("skills"),
		dock: runtimeSessionRef
			? { open: false, count: extensionDockItemCount, toggle: () => workbenchPanel.openSideMode("dock") }
			: null,
	});
	return (
		<div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto p-2">
			{tools.map((tool) => (
				<button
					key={tool.id}
					type="button"
					disabled={tool.disabled === true}
					// Tool callbacks take an optional focus path; a bare handler would pass the click event.
					onClick={() => tool.onSelect()}
					className={cn(
						"workspace-tool-card flex min-h-10 w-full items-center gap-2.5 rounded-control px-2.5 text-left text-ui",
						"text-text-primary transition-colors disabled:opacity-40 motion-reduce:transition-none",
					)}
				>
					<span className="shrink-0 text-text-muted">{tool.icon}</span>
					<span className="min-w-0 flex-1 truncate">{tool.title}</span>
					{tool.count !== undefined && tool.count > 0 && (
						<span className="shrink-0 font-mono text-xs tabular-nums text-text-muted">
							{formatWorkspaceToolCount(tool.count)}
						</span>
					)}
				</button>
			))}
			{featurePages.map(([id, Icon]) => (
				<button
					key={id}
					type="button"
					disabled={activeSessionRef === null}
					onClick={() => tabs.openFeatureViewer(id)}
					className={cn(
						"workspace-tool-card flex min-h-10 w-full items-center gap-2.5 rounded-control px-2.5 text-left text-ui",
						"text-text-primary transition-colors disabled:opacity-40 motion-reduce:transition-none",
					)}
				>
					<Icon className="size-4 shrink-0 text-text-muted" aria-hidden="true" />
					<span className="min-w-0 flex-1 truncate">{t(featurePageTitleKeys[id])}</span>
				</button>
			))}
		</div>
	);
}
