import type { FeaturePageId } from "@renderer/components/workbench/feature-navigation";
import type { SessionRef } from "@ling/contracts/session-ref";
import type { SkillInfo } from "@ling/contracts/skill";
import { MaterialFileIcon } from "@renderer/components/material-code-icon";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "@renderer/components/ui/context-menu";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { ICON_BUTTON_CLASS } from "@renderer/components/ui/icon-button";
import { TooltipIconButton } from "@renderer/components/ui/tooltip-icon-button";
import type { WorkspaceSessionStatus } from "@renderer/features/sessions/session-status";
import { noDragRegionClassName, shortcut } from "@renderer/lib/platform";
import { cn } from "@renderer/lib/utils";
import { Bot, ChevronDown, FileDiff, GraduationCap, MessageSquare, Plus, X, PanelsTopLeft } from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { SessionActionsMenuModel } from "../sessions/session-actions-menu";
import { SessionStatusIcon } from "../sessions/session-list-item";
import { sessionMenuGroups } from "../sessions/session-menu";
import { useTabDrag } from "./use-tab-drag";

export type WorkspaceTab = { key: string; preview: boolean; dirty?: boolean } & (
	| {
			kind: "session";
			ref: SessionRef;
			title: string;
			projectName: string;
			status: WorkspaceSessionStatus;
			child: boolean;
	  }
	| { kind: "file" | "review"; path: string }
	| { kind: "skill"; skill: SkillInfo }
	| { kind: "feature"; id: FeaturePageId; title: string }
);

interface WorkspaceTabsProps {
	tabs: readonly WorkspaceTab[];
	activeKey: string | null;
	menuFor?: (ref: SessionRef) => SessionActionsMenuModel | undefined;
	onSelect: (key: string) => void;
	onKeepOpen: (key: string) => void;
	onClose: (key: string) => void;
	onCloseOthers: (key: string) => void;
	onCloseRight: (key: string) => void;
	onCloseAll: () => void;
	onReorder: (key: string, target: string, edge: "before" | "after") => void;
	onNewSession?: () => void;
	label?: string;
}

function TabIcon({ tab }: { tab: WorkspaceTab }) {
	const className = "size-3.5 shrink-0 text-text-muted";
	if (tab.kind === "feature") return <PanelsTopLeft className={className} aria-hidden="true" />;
	if (tab.kind === "skill") return <GraduationCap className={className} aria-hidden="true" />;
	if (tab.kind === "session")
		return tab.child ? (
			<Bot className={className} aria-hidden="true" />
		) : (
			<MessageSquare className={className} aria-hidden="true" />
		);
	return tab.kind === "file" ? (
		<MaterialFileIcon path={tab.path} className={className} />
	) : (
		<FileDiff className={className} aria-hidden="true" />
	);
}

/** Modern editor tabs occupy the normal titlebar; each tab owns its rounded fill. */
export function WorkspaceTabs({
	tabs,
	activeKey,
	menuFor,
	onSelect,
	onKeepOpen,
	onClose,
	onCloseOthers,
	onCloseRight,
	onCloseAll,
	onReorder,
	onNewSession,
	label: groupLabel,
}: WorkspaceTabsProps) {
	const { t } = useTranslation();
	const closeHintId = useId();
	const hasActiveTab = tabs.some((tab) => tab.key === activeKey);
	const mixedProjects = new Set(tabs.flatMap((tab) => (tab.kind === "session" ? [tab.projectName] : []))).size > 1;
	const stripRef = useRef<HTMLDivElement>(null);
	const tabDrag = useTabDrag(
		stripRef,
		tabs.map((tab) => tab.key),
		onReorder,
	);
	const { drag, drop } = tabDrag;
	useEffect(() => {
		stripRef.current
			?.querySelector<HTMLElement>('[aria-selected="true"]')
			?.scrollIntoView({ block: "nearest", inline: "nearest" });
	}, [activeKey, tabs.length]);
	const label = (tab: WorkspaceTab) =>
		tab.kind === "session" || tab.kind === "feature"
			? tab.title
			: tab.kind === "skill"
				? tab.skill.name
				: tab.path.split(/[/\\]/).at(-1)!;
	const title = (tab: WorkspaceTab) =>
		tab.kind === "feature"
			? tab.title
			: tab.kind === "skill"
				? tab.skill.name
				: tab.kind === "session"
					? mixedProjects
						? `${tab.projectName} · ${tab.title}`
						: tab.title
					: tab.kind === "review"
						? t("changes.diffTabTitle", { path: tab.path })
						: tab.path;
	const handleKeys = (event: KeyboardEvent<HTMLButtonElement>, tab: WorkspaceTab) => {
		if (event.target !== event.currentTarget) return;
		const index = tabs.findIndex((item) => item.key === tab.key);
		let next: WorkspaceTab | undefined;
		if (event.key === "ArrowRight") next = tabs[(index + 1) % tabs.length];
		else if (event.key === "ArrowLeft") next = tabs[(index - 1 + tabs.length) % tabs.length];
		else if (event.key === "Home") next = tabs[0];
		else if (event.key === "End") next = tabs.at(-1);
		else if (event.key === "Enter" || event.key === " ") {
			event.preventDefault();
			onSelect(tab.key);
		} else if (event.key === "Delete") {
			event.preventDefault();
			const remaining = index < tabs.length - 1 ? index + 1 : index - 1;
			stripRef.current?.querySelectorAll<HTMLElement>('[role="tab"]')[remaining]?.focus();
			onClose(tab.key);
		}
		if (next !== undefined) {
			event.preventDefault();
			stripRef.current?.querySelectorAll<HTMLElement>('[role="tab"]')[tabs.indexOf(next)]?.focus();
			onSelect(next.key);
		}
	};

	return (
		<div data-workspace-tabs="" className="flex min-w-0 flex-1 items-center gap-1">
			<span id={closeHintId} className="sr-only">
				{t("session.closeTabHint")}
			</span>
			<div
				ref={stripRef}
				role="tablist"
				aria-label={groupLabel ?? t("session.tabs")}
				className={cn(
					"flex min-w-0 items-center gap-1 overflow-x-auto py-1 [scrollbar-width:none]",
					noDragRegionClassName,
				)}
			>
				{tabs.map((tab, index) => {
					const active = tab.key === activeKey;
					const menu = tab.kind === "session" ? menuFor?.(tab.ref) : undefined;
					const groups = menu === undefined ? [] : sessionMenuGroups(menu.session, menu.handlers);
					return (
						<ContextMenu key={tab.key}>
							<ContextMenuTrigger asChild>
								<button
									type="button"
									role="tab"
									tabIndex={active || (!hasActiveTab && index === 0) ? 0 : -1}
									aria-selected={active}
									aria-describedby={closeHintId}
									title={title(tab)}
									data-preview={tab.preview || undefined}
									onClick={(event) => {
										if ((event.target as HTMLElement).closest("[data-tab-close]")) onClose(tab.key);
										else if (!tabDrag.consumeDragClick()) onSelect(tab.key);
									}}
									onDoubleClick={() => onKeepOpen(tab.key)}
									onKeyDown={(event) => handleKeys(event, tab)}
									onAuxClick={(event) => {
										if (event.button === 1) {
											event.preventDefault();
											onClose(tab.key);
										}
									}}
									onPointerDown={(event) => tabDrag.pointerDown(event, tab.key)}
									onPointerMove={tabDrag.pointerMove}
									onPointerUp={() => tabDrag.finish(true)}
									onPointerCancel={() => tabDrag.finish(false)}
									onLostPointerCapture={() => tabDrag.finish(false)}
									style={drag?.key === tab.key ? { transform: `translateX(${drag.offset}px)`, zIndex: 1 } : undefined}
									className={cn(
										"group relative isolate flex h-7 max-w-56 min-w-0 shrink-0 cursor-default select-none items-center gap-1.5 rounded-control px-2 text-xs text-text-muted hover:bg-surface-hover/70 hover:text-text-primary focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-text-muted",
										active && "bg-surface-hover text-text-primary",
										noDragRegionClassName,
										drag?.key === tab.key && "bg-surface-hover opacity-80",
										drop?.key === tab.key &&
											(drop.edge === "before"
												? "before:absolute before:-left-0.5 before:inset-y-0 before:w-px before:bg-text-primary"
												: "after:absolute after:-right-0.5 after:inset-y-0 after:w-px after:bg-text-primary"),
									)}
								>
									<TabIcon tab={tab} />
									<span className={cn("min-w-0 flex-1 truncate", tab.preview && "italic")}>{label(tab)}</span>
									{tab.kind === "session" && (
										<>
											{mixedProjects && <span className="max-w-20 truncate text-text-muted/70">{tab.projectName}</span>}
											<SessionStatusIcon status={tab.status} />
										</>
									)}
									<span
										data-tab-close=""
										aria-hidden="true"
										title={t("session.closeTab")}
										className="flex size-4 shrink-0 items-center justify-center rounded-sm text-text-muted opacity-0 hover:bg-text-muted/15 hover:text-text-primary group-hover:opacity-100 group-focus-within:opacity-100 group-aria-selected:opacity-100"
									>
										{tab.dirty ? <span className="size-1.5 rounded-full bg-text-secondary group-hover:hidden" /> : null}
										<X className={cn("size-3", tab.dirty && "hidden group-hover:block")} aria-hidden="true" />
									</span>
								</button>
							</ContextMenuTrigger>
							<ContextMenuContent className="w-48">
								<ContextMenuItem onClick={() => onClose(tab.key)}>{t("session.closeTab")}</ContextMenuItem>
								<ContextMenuItem disabled={tabs.length < 2} onClick={() => onCloseOthers(tab.key)}>
									{t("session.closeOtherTabs")}
								</ContextMenuItem>
								<ContextMenuItem disabled={index === tabs.length - 1} onClick={() => onCloseRight(tab.key)}>
									{t("session.closeTabsToRight")}
								</ContextMenuItem>
								<ContextMenuItem onClick={onCloseAll}>{t("session.closeAllTabs")}</ContextMenuItem>
								{tab.preview && (
									<>
										<ContextMenuSeparator />
										<ContextMenuItem onClick={() => onKeepOpen(tab.key)}>{t("session.keepTabOpen")}</ContextMenuItem>
									</>
								)}
								{groups.map((group, groupIndex) => (
									// eslint-disable-next-line react/no-array-index-key -- groups have a fixed, ordered structure.
									<div key={groupIndex} className="contents">
										<ContextMenuSeparator />
										{group.map((entry) => (
											<ContextMenuItem
												key={entry.key}
												{...(entry.destructive ? { variant: "destructive" as const } : {})}
												onClick={entry.onSelect}
											>
												{t(entry.labelKey)}
											</ContextMenuItem>
										))}
									</div>
								))}
							</ContextMenuContent>
						</ContextMenu>
					);
				})}
			</div>
			{onNewSession && (
				<div className={cn("flex shrink-0 items-center", noDragRegionClassName)}>
					<TooltipIconButton onClick={onNewSession} label={t("nav.newConversation")} shortcut={shortcut("N")}>
						<Plus className="size-4" aria-hidden="true" />
					</TooltipIconButton>
				</div>
			)}
			<div className="min-w-2 flex-1" />
			{tabs.length > 1 && (
				<DropdownMenu>
					<DropdownMenuTrigger
						render={
							<button
								type="button"
								aria-label={t("session.tabList")}
								className={cn(ICON_BUTTON_CLASS, noDragRegionClassName)}
							/>
						}
					>
						<ChevronDown className="size-4" aria-hidden="true" />
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end" className="max-h-80 w-64 overflow-y-auto">
						{tabs.map((tab) => (
							<DropdownMenuItem key={tab.key} onClick={() => onSelect(tab.key)}>
								<TabIcon tab={tab} />
								<span className={cn("min-w-0 flex-1 truncate", tab.preview && "italic")}>{label(tab)}</span>
							</DropdownMenuItem>
						))}
					</DropdownMenuContent>
				</DropdownMenu>
			)}
		</div>
	);
}
