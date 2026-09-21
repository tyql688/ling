import { builtinWorkspaceTools, formatWorkspaceToolCount } from "./workspace-tool-items";
import { TooltipIconButton } from "@renderer/components/ui/tooltip-icon-button";
import { shortcut } from "@renderer/lib/platform";
import { cn } from "@renderer/lib/utils";
import { useSessionExtensionMeta } from "@renderer/features/chat/extension-ui/use-session-extension-meta";
import { useReviewWorkspace } from "@renderer/features/review/use-review-workspace";
import { useWorkbenchLayout } from "@renderer/components/workbench/workbench-layout-context";
import {
	DropdownMenu,
	DropdownMenuTrigger,
	DropdownMenuContent,
	DropdownMenuItem,
} from "@renderer/components/ui/dropdown-menu";
import { useReadingWorkspace } from "./reading-state";
import {
	ChevronDown,
	ListTodo,
	Maximize2,
	MessageCircleQuestion,
	Minimize2,
	PanelRightOpen,
	SquareTerminal,
	type LucideIcon,
} from "lucide-react";
import { featurePageTitleKeys, type FeaturePageId } from "@renderer/components/workbench/feature-navigation";
import { useTranslation } from "react-i18next";
import { useEffect, useState } from "react";
import {
	useWorkspaceField,
	useWorkspaceOwner,
	workspacePanelAtom,
	workspaceSelectionAtom,
	workspaceTabsAtom,
} from "./workspace-state";

const featurePages: [FeaturePageId, LucideIcon][] = [
	["todo", ListTodo],
	["questions", MessageCircleQuestion],
	["background-tasks", SquareTerminal],
];

/** Window-level workspace controls keep the same order across views. */
export function WorkspaceHeaderActions() {
	const { t } = useTranslation();
	const activeSessionRef = useWorkspaceField(workspaceSelectionAtom, "activeSessionRef");
	const { sideVisible, toggleSidePanel, hasReading, compact, floating } = useWorkbenchLayout();
	const [reading, setReading] = useReadingWorkspace(activeSessionRef);
	const terminalOpen = reading.terminalOpen;
	return (
		<>
			<TooltipIconButton
				onClick={() => setReading((current) => ({ ...current, terminalOpen: !current.terminalOpen }))}
				label={t(terminalOpen ? "terminal.closePanel" : "terminal.openPanel")}
				disabled={activeSessionRef === null}
				aria-pressed={terminalOpen}
				shortcut={shortcut("`")}
				className={cn("disabled:opacity-35", terminalOpen && "bg-surface-hover text-text-primary")}
			>
				<SquareTerminal className="size-4" aria-hidden="true" />
			</TooltipIconButton>
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
		</>
	);
}

/** One selector switches the contextual sidebar without a mandatory tool-home hop. */
export function WorkspaceToolSelector({ title }: { title: string }) {
	const activeSessionRef = useWorkspaceField(workspaceSelectionAtom, "activeSessionRef");
	const [reading] = useReadingWorkspace(activeSessionRef);
	const [open, setOpen] = useState(false);
	useEffect(() => {
		// Remote tool actions finish navigation before their menu contribution is unmounted.
		setOpen(false);
	}, [reading]);
	const runtimeSessionRef = useWorkspaceField(workspaceSelectionAtom, "runtimeSessionRef");
	const workbenchPanel = useWorkspaceOwner(workspacePanelAtom);
	const tabs = useWorkspaceOwner(workspaceTabsAtom);
	const { t } = useTranslation();
	const { review: changeReview, files: changedFiles, refresh: refreshChanges } = useReviewWorkspace();
	const { dockItems: extensionDockItemCount } = useSessionExtensionMeta(runtimeSessionRef);
	const workspaceChangeCount = changeReview.snapshot?.scopes.workspace.count ?? changedFiles.files.length;

	const toolsDisabled = activeSessionRef === null;

	const tools = builtinWorkspaceTools({
		t,
		disabled: toolsDisabled,
		explorer: { open: workbenchPanel.explorerOpen, toggle: () => workbenchPanel.openSideMode("explorer") },
		review: {
			open: workbenchPanel.reviewOpen,
			count: workspaceChangeCount,
			error: changedFiles.error !== null,
			toggle: workbenchPanel.openReviewWorkspace,
			refresh: refreshChanges,
		},
		piConfig: { toggle: () => workbenchPanel.openSideMode("piConfig") },
		skills: activeSessionRef === null ? undefined : () => workbenchPanel.openSideMode("skills"),
		dock: runtimeSessionRef
			? {
					open: workbenchPanel.dockOpen,
					count: extensionDockItemCount,
					toggle: () => workbenchPanel.openSideMode("dock"),
				}
			: null,
	});

	return (
		<DropdownMenu open={open} onOpenChange={setOpen}>
			<DropdownMenuTrigger
				render={
					<button
						type="button"
						aria-label={t("reading.chooseSidebar")}
						className="flex h-8 min-w-0 items-center gap-2 rounded-control px-2 text-ui font-medium text-text-primary hover:bg-surface-hover"
					/>
				}
			>
				<span className="truncate">{title}</span>
				<ChevronDown className="size-3.5 shrink-0 text-text-muted" aria-hidden="true" />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="w-56">
				{tools.map((item) => (
					<DropdownMenuItem key={item.id} disabled={item.disabled === true} onSelect={() => item.onSelect()}>
						{item.icon}
						<span className="min-w-0 flex-1">{item.title}</span>
						{item.count !== undefined && item.count > 0 && (
							<span className="text-xs tabular-nums text-text-muted">{formatWorkspaceToolCount(item.count)}</span>
						)}
					</DropdownMenuItem>
				))}
				{featurePages.map(([id, Icon]) => (
					<DropdownMenuItem key={id} disabled={toolsDisabled} onSelect={() => tabs.openFeatureViewer(id)}>
						<Icon className="size-4" aria-hidden="true" />
						<span className="min-w-0 flex-1">{t(featurePageTitleKeys[id])}</span>
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
