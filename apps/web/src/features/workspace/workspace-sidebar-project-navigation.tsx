import type { SessionSummary } from "@ling/contracts/session";
import { type SessionRef, sameSessionRef, toSessionRef } from "@ling/contracts/session-ref";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { TooltipIconButton } from "@renderer/components/ui/tooltip-icon-button";
import { ProjectDiagnosticList } from "@renderer/features/projects/project-hover-card";
import { cn } from "@renderer/lib/utils";
import {
	AlertTriangle,
	Check,
	ChevronDown,
	ChevronRight,
	Ellipsis,
	Folder,
	FolderPlus,
	Folders,
	GitBranch,
	Pin,
	Plus,
} from "lucide-react";
import { type ReactElement, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { MoreSessionsButton, ProjectActivityCount } from "./workspace-sidebar-controls";
import type { WorkspaceSidebarProject } from "./workspace-sidebar-model";

/** Sessions shown per group up front in the multi-project grouped view. */
const GROUP_INITIAL_COUNT = 5;
/** Page size of the session list "more" pagination. */
const SESSION_PAGE_COUNT = 10;
/** Initial session count under a single-project scope; slightly more than the grouped view to fill one screen. */
const SCOPED_INITIAL_COUNT = 12;

type ProjectHoverCardRenderer = (
	entry: WorkspaceSidebarProject,
	trigger: ReactElement,
	disabled?: boolean,
) => ReactElement;

type ProjectActionsMenuRenderer = (
	entry: WorkspaceSidebarProject,
	trigger: ReactElement,
	onOpenChange: (open: boolean) => void,
) => ReactElement;

function visibleSessionsIncludingSelection(
	sessions: readonly SessionSummary[],
	limit: number,
	activeSessionRef: SessionRef | null,
): SessionSummary[] {
	const visible = sessions.slice(0, limit);
	if (activeSessionRef === null) return visible;
	const selected = sessions.find(
		(session, index) => index >= limit && sameSessionRef(toSessionRef(session), activeSessionRef),
	);
	return selected === undefined ? visible : [...visible, selected];
}

interface ProjectScopeSelectorProps {
	projects: readonly WorkspaceSidebarProject[];
	scopedProject: WorkspaceSidebarProject | null;
	renderProjectHoverCard: ProjectHoverCardRenderer;
	onScopeChange: (cwd: string | null) => void;
	onAddProject: () => void;
}

export function ProjectScopeSelector({
	projects,
	scopedProject,
	renderProjectHoverCard,
	onScopeChange,
	onAddProject,
}: ProjectScopeSelectorProps) {
	const { t } = useTranslation();
	const [menuOpen, setMenuOpen] = useState(false);
	const dropdown = (
		<DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
			<DropdownMenuTrigger
				render={
					<button
						type="button"
						aria-label={t("sidebar.filterProject")}
						className="flex h-10 min-w-0 max-w-full items-center gap-1.5 rounded-control px-2 text-text-primary transition-colors hover:bg-surface-hover"
					/>
				}
			>
				<span
					aria-hidden="true"
					className="shrink-0 font-[Georgia,Times_New_Roman,serif] text-[30px] leading-none font-normal italic tracking-[-0.04em]"
				>
					pi
				</span>
				{scopedProject && (
					<span className="min-w-0 truncate text-xs text-text-muted">{scopedProject.project.name}</span>
				)}
				{scopedProject?.project.availability === "missing" && (
					<span className="shrink-0 text-xs text-warning">{t("project.directoryMissing")}</span>
				)}
				<ChevronDown className="size-3.5 shrink-0" aria-hidden="true" />
			</DropdownMenuTrigger>
			<DropdownMenuContent className="w-60">
				<DropdownMenuItem onClick={() => onScopeChange(null)}>
					<Folders aria-hidden="true" />
					<span className="min-w-0 flex-1 truncate">{t("sidebar.allProjects")}</span>
					{scopedProject === null && <Check aria-hidden="true" />}
				</DropdownMenuItem>
				{projects.length > 0 && <DropdownMenuSeparator />}
				{projects.map((entry) => (
					<DropdownMenuItem
						key={entry.project.cwd}
						onClick={() => onScopeChange(entry.project.cwd)}
						className="min-w-0"
					>
						{entry.project.meta.kind === "worktree" ? <GitBranch aria-hidden="true" /> : <Folder aria-hidden="true" />}
						<span className="min-w-0 flex-1 truncate">{entry.project.name}</span>
						{entry.project.availability === "missing" && (
							<span className="shrink-0 text-xs text-warning">{t("project.directoryMissing")}</span>
						)}
						{entry.pinned && (
							<>
								<Pin className="size-3 shrink-0 fill-current text-text-muted" aria-hidden="true" />
								<span className="sr-only">{t("sidebar.pinned")}</span>
							</>
						)}
						{entry.project.diagnostics.length > 0 && (
							<Tooltip>
								<TooltipTrigger render={<span className="inline-flex" />}>
									<AlertTriangle className="text-warning" aria-hidden="true" />
									<span className="sr-only">
										{t("project.diagnosticsCount", { count: entry.project.diagnostics.length })}
									</span>
								</TooltipTrigger>
								<TooltipContent side="right" className="max-w-sm">
									<ProjectDiagnosticList diagnostics={entry.project.diagnostics} />
								</TooltipContent>
							</Tooltip>
						)}
						<span className="font-mono text-xs tabular-nums text-text-muted">{entry.sessionCount}</span>
						{scopedProject?.project.cwd === entry.project.cwd && <Check aria-hidden="true" />}
					</DropdownMenuItem>
				))}
				<DropdownMenuSeparator />
				<DropdownMenuItem onClick={onAddProject}>
					<FolderPlus aria-hidden="true" />
					{t("project.add")}
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
	const trigger = <div className="min-w-0 flex-1">{dropdown}</div>;
	return scopedProject === null ? trigger : renderProjectHoverCard(scopedProject, trigger, menuOpen);
}

interface WorkspaceProjectSessionsProps {
	projects: readonly WorkspaceSidebarProject[];
	scopedProject: WorkspaceSidebarProject | null;
	activeSessions: readonly SessionSummary[];
	activeSessionRef: SessionRef | null;
	activityCountByCwd: ReadonlyMap<string, number>;
	renderProjectHoverCard: ProjectHoverCardRenderer;
	renderProjectActionsMenu: ProjectActionsMenuRenderer;
	onNewSession: (cwd: string) => void;
	renderSession: (session: SessionSummary) => ReactElement;
}

export function WorkspaceProjectSessions({
	projects,
	scopedProject,
	activeSessions,
	activeSessionRef,
	activityCountByCwd,
	renderProjectHoverCard,
	renderProjectActionsMenu,
	onNewSession,
	renderSession,
}: WorkspaceProjectSessionsProps) {
	const { t } = useTranslation();
	/** The project whose actions menu is open keeps its header actions visible and its hover card closed. */
	const [menuProjectCwd, setMenuProjectCwd] = useState<string | null>(null);
	const [projectExpandedOverrides, setProjectExpandedOverrides] = useState<Record<string, boolean>>({});
	const [visibleCountsByCwd, setVisibleCountsByCwd] = useState<Record<string, number>>({});
	const activeSessionsByCwd = useMemo(() => {
		const grouped = new Map<string, SessionSummary[]>();
		for (const session of activeSessions) {
			const current = grouped.get(session.cwd);
			if (current === undefined) grouped.set(session.cwd, [session]);
			else current.push(session);
		}
		return grouped;
	}, [activeSessions]);
	const visibleCount = (cwd: string, initial: number): number => {
		const count = visibleCountsByCwd[cwd];
		return count === undefined ? initial : count;
	};
	const showMore = (cwd: string, initial: number) => {
		setVisibleCountsByCwd((current) => {
			const count = current[cwd];
			const base = count === undefined ? initial : count;
			return { ...current, [cwd]: base + SESSION_PAGE_COUNT };
		});
	};

	if (scopedProject !== null) {
		const count = visibleCount(scopedProject.project.cwd, SCOPED_INITIAL_COUNT);
		const visible = visibleSessionsIncludingSelection(activeSessions, count, activeSessionRef);
		const hidden = activeSessions.length - visible.length;
		return (
			<div className="flex flex-col gap-px">
				{visible.map(renderSession)}
				{hidden > 0 && (
					<MoreSessionsButton
						label={t("sidebar.showMore", { count: hidden })}
						onClick={() => showMore(scopedProject.project.cwd, SCOPED_INITIAL_COUNT)}
					/>
				)}
			</div>
		);
	}

	const groups = projects
		.map((entry) => ({ entry, sessions: activeSessionsByCwd.get(entry.project.cwd) ?? [] }))
		.filter((group) => group.sessions.length > 0);
	return (
		<div className="flex flex-col gap-1.5">
			{groups.map(({ entry, sessions }, index) => {
				const override = projectExpandedOverrides[entry.project.cwd];
				const defaultExpanded = entry.pinned || activeSessionRef?.cwd === entry.project.cwd || index < 2;
				const expanded = override === undefined ? defaultExpanded : override;
				const count = visibleCount(entry.project.cwd, GROUP_INITIAL_COUNT);
				const visible = visibleSessionsIncludingSelection(sessions, count, activeSessionRef);
				const hidden = sessions.length - visible.length;
				const activityCount = activityCountByCwd.get(entry.project.cwd) ?? 0;
				const ProjectIcon = entry.project.meta.kind === "worktree" ? GitBranch : Folder;
				const toggleExpanded = () => {
					setProjectExpandedOverrides((current) => ({
						...current,
						[entry.project.cwd]: !expanded,
					}));
				};
				const cwd = entry.project.cwd;
				const menuOpen = menuProjectCwd === cwd;
				const trigger = (
					<div className="group/project relative">
						<button
							type="button"
							onClick={toggleExpanded}
							aria-expanded={expanded}
							className={cn(
								"flex h-8 w-full min-w-0 items-center gap-1.5 rounded-control pr-2 pl-1.5 text-left text-ui font-medium text-text-primary transition-colors hover:bg-surface-hover focus-visible:bg-surface-hover group-hover/project:pr-15 group-has-[:focus-visible]/project:pr-15",
								menuOpen && "bg-surface-hover pr-15",
							)}
						>
							<ChevronRight
								className={cn(
									"size-3 shrink-0 text-text-muted transition-transform motion-reduce:transition-none",
									expanded && "rotate-90",
								)}
								aria-hidden="true"
							/>
							<ProjectIcon className="size-3.5 shrink-0 text-text-muted" aria-hidden="true" />
							<span className="min-w-0 flex-1 truncate">{entry.project.name}</span>
							{entry.project.availability === "missing" && (
								<span className="shrink-0 text-xs font-normal text-warning">{t("project.directoryMissing")}</span>
							)}
							{entry.pinned && (
								<>
									<Pin className="size-3 shrink-0 fill-current text-text-muted" aria-hidden="true" />
									<span className="sr-only">{t("sidebar.pinned")}</span>
								</>
							)}
							{/* Hover actions take this slot; sr-only keeps the count in the button's accessible name. */}
							<span
								className={cn(
									"flex shrink-0 items-center font-normal group-hover/project:sr-only group-has-[:focus-visible]/project:sr-only",
									menuOpen && "sr-only",
								)}
							>
								{activityCount > 0 ? (
									<ProjectActivityCount
										count={activityCount}
										label={t("sidebar.projectActivityCount", { count: activityCount })}
									/>
								) : (
									<>
										<span aria-hidden="true" className="text-xs tabular-nums text-text-muted">
											{sessions.length}
										</span>
										<span className="sr-only">{t("sidebar.projectSessionCount", { count: sessions.length })}</span>
									</>
								)}
							</span>
						</button>
						<div
							className={cn(
								"pointer-events-none absolute top-1/2 right-1 flex -translate-y-1/2 items-center opacity-0 transition-opacity group-hover/project:pointer-events-auto group-hover/project:opacity-100 group-has-[:focus-visible]/project:pointer-events-auto group-has-[:focus-visible]/project:opacity-100 motion-reduce:transition-none",
								menuOpen && "pointer-events-auto opacity-100",
							)}
						>
							{entry.projectOpen && (
								<TooltipIconButton label={t("session.new")} onClick={() => onNewSession(cwd)} className="size-6">
									<Plus className="size-3.5" aria-hidden="true" />
								</TooltipIconButton>
							)}
							{renderProjectActionsMenu(
								entry,
								<button
									type="button"
									aria-label={t("project.moreActions")}
									className="flex size-6 items-center justify-center rounded-control text-text-muted transition-colors hover:bg-surface-hover hover:text-text-primary"
								>
									<Ellipsis className="size-3.5" aria-hidden="true" />
								</button>,
								(open) => setMenuProjectCwd((current) => (open ? cwd : current === cwd ? null : current)),
							)}
						</div>
					</div>
				);
				return (
					<section key={cwd} aria-label={entry.project.name}>
						{renderProjectHoverCard(entry, trigger, menuOpen)}
						{expanded && (
							<div className="flex flex-col gap-px pl-5">
								{visible.map(renderSession)}
								{hidden > 0 && (
									<MoreSessionsButton
										label={t("sidebar.showMore", { count: hidden })}
										onClick={() => showMore(cwd, GROUP_INITIAL_COUNT)}
									/>
								)}
							</div>
						)}
					</section>
				);
			})}
		</div>
	);
}
