import type { OpenProjectInfo } from "@ling/contracts/project";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@renderer/components/ui/hover-card";
import { tildify } from "@renderer/lib/format-path";
import { cn } from "@renderer/lib/utils";
import { Activity, AlertTriangle, ArrowUpRight, Folder, GitBranch, MessageCircle, Pin, Settings2 } from "lucide-react";
import { type ReactElement, type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ProjectActionTarget } from "./project-actions-menu";

interface ProjectHoverCardProps {
	project: ProjectActionTarget["project"];
	pinned: boolean;
	sessionCount: number;
	activityCount: number;
	trigger: ReactElement;
	side: "right" | "bottom";
	disabled?: boolean | undefined;
	renderMoreActions?: ((trigger: ReactElement, onOpenChange: (open: boolean) => void) => ReactNode) | undefined;
	renderContextMenu?: ((trigger: ReactElement, onOpenChange: (open: boolean) => void) => ReactNode) | undefined;
	onTogglePinned: () => void;
	onReveal: () => void;
}

export function ProjectHoverCard({
	project,
	pinned,
	sessionCount,
	activityCount,
	trigger,
	side,
	disabled = false,
	renderMoreActions,
	renderContextMenu,
	onTogglePinned,
	onReveal,
}: ProjectHoverCardProps) {
	const { t } = useTranslation();
	const ProjectIcon = project.meta.kind === "worktree" ? GitBranch : Folder;
	const [hoverOpen, setHoverOpen] = useState(false);
	const [actionsOpen, setActionsOpen] = useState(false);
	const [contextMenuOpen, setContextMenuOpen] = useState(false);
	const pointerInsideTrigger = useRef(false);

	useEffect(() => {
		if (!disabled) return;
		setHoverOpen(false);
		setActionsOpen(false);
		setContextMenuOpen(false);
	}, [disabled]);

	const handleActionsOpenChange = (open: boolean) => {
		setActionsOpen(open);
		if (open) setHoverOpen(true);
	};
	const handleContextMenuOpenChange = (open: boolean) => {
		setContextMenuOpen(open);
		if (open) setHoverOpen(false);
	};
	const detailsTrigger = renderContextMenu?.(trigger, handleContextMenuOpenChange) ?? trigger;
	const actionsTrigger = (
		<button
			type="button"
			aria-label={t("project.edit")}
			className="grid min-h-7 w-full min-w-0 grid-cols-[1rem_minmax(0,1fr)] items-center gap-x-1.5 rounded-control px-1 text-left text-xs text-text-primary transition-colors hover:bg-surface-hover focus-visible:bg-surface-hover"
		>
			<Settings2 className="size-3.5 text-text-muted" aria-hidden="true" />
			<span className="truncate">{t("project.edit")}</span>
		</button>
	);

	return (
		<HoverCard
			open={!disabled && !contextMenuOpen && (hoverOpen || actionsOpen)}
			onOpenChange={(open) => {
				if (disabled || contextMenuOpen || (open && !pointerInsideTrigger.current)) return;
				setHoverOpen(open);
			}}
		>
			<HoverCardTrigger
				render={
					<div
						className="min-w-0"
						onPointerEnter={() => {
							pointerInsideTrigger.current = true;
						}}
						onPointerLeave={() => {
							pointerInsideTrigger.current = false;
						}}
					>
						{detailsTrigger}
					</div>
				}
			/>
			<HoverCardContent
				side={side}
				className="w-80 rounded-panel bg-popover/95 p-2 backdrop-blur-xl"
				aria-label={t("sidebar.projectDetails", { project: project.name })}
			>
				<div className="flex min-w-0 flex-col gap-1.5">
					<div className="grid min-h-6 min-w-0 grid-cols-[1rem_minmax(0,1fr)_1.25rem] items-center gap-x-1.5 rounded-control px-1">
						<ProjectIcon className="size-3.5 text-text-muted" aria-hidden="true" />
						<div className="flex min-w-0 items-center gap-1.5">
							<span className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">{project.name}</span>
							{project.diagnostics.length > 0 && (
								<AlertTriangle className="size-3.5 shrink-0 text-warning" aria-hidden="true" />
							)}
						</div>
						<button
							type="button"
							onClick={onTogglePinned}
							aria-label={t(pinned ? "project.unpin" : "project.pin")}
							aria-pressed={pinned}
							className="flex size-6 items-center justify-center rounded-control text-text-muted transition-colors hover:bg-surface-hover hover:text-text-primary focus-visible:bg-surface-hover"
						>
							<Pin className={cn("size-3.5", pinned && "fill-current")} aria-hidden="true" />
						</button>
					</div>
					<div className="grid min-h-5 min-w-0 grid-cols-[1rem_minmax(0,1fr)] items-center gap-x-1.5 px-1 text-xs text-text-muted">
						<MessageCircle className="size-3.5" aria-hidden="true" />
						<div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 tabular-nums">
							<span>{t("sidebar.projectSessionCount", { count: sessionCount })}</span>
							{activityCount > 0 && (
								<span className="inline-flex items-center gap-1 text-accent">
									<Activity className="size-3" aria-hidden="true" />
									{t("sidebar.projectActivityCount", { count: activityCount })}
								</span>
							)}
						</div>
					</div>
				</div>

				{project.availability === "missing" && (
					<div className="mt-1.5 flex items-center gap-1.5 px-1 text-xs text-warning">
						<AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
						<span>{t("project.directoryMissing")}</span>
					</div>
				)}

				{project.diagnostics.length > 0 && (
					<div className="mt-1.5 border-border-subtle border-t px-1 pt-1.5 text-xs">
						<ProjectDiagnosticList diagnostics={project.diagnostics} />
					</div>
				)}

				<div className="mt-1.5 border-border-subtle border-t pt-1.5">
					<button
						type="button"
						onClick={onReveal}
						aria-label={t("project.showInFileManager")}
						className="group/path grid min-h-7 w-full min-w-0 grid-cols-[1rem_minmax(0,1fr)_1.25rem] items-center gap-x-1.5 rounded-control px-1 text-left text-xs text-text-muted transition-colors hover:bg-surface-hover hover:text-text-primary focus-visible:bg-surface-hover"
					>
						<Folder className="size-3.5" aria-hidden="true" />
						<span className="min-w-0 break-all" dir="auto">
							{tildify(project.cwd)}
						</span>
						<ArrowUpRight
							className="size-3.5 opacity-0 transition-opacity group-hover/path:opacity-100 group-focus-visible/path:opacity-100"
							aria-hidden="true"
						/>
					</button>
				</div>

				{renderMoreActions && (
					<div className="mt-1.5 border-border-subtle border-t pt-1.5">
						{renderMoreActions(actionsTrigger, handleActionsOpenChange)}
					</div>
				)}
			</HoverCardContent>
		</HoverCard>
	);
}

/** Diagnostics that apply to this project alone (main already drops global and informational ones). */
export function ProjectDiagnosticList({ diagnostics }: { diagnostics: OpenProjectInfo["diagnostics"] }) {
	return (
		<ul className="flex flex-col gap-1.5 text-left font-normal">
			{diagnostics.map((diagnostic) => (
				<li key={`${diagnostic.code}:${diagnostic.message}:${diagnostic.path ?? ""}`} className="min-w-0">
					<p className="text-text-primary">{diagnostic.message}</p>
					{diagnostic.path && <p className="truncate text-text-muted">{tildify(diagnostic.path)}</p>}
				</li>
			))}
		</ul>
	);
}
