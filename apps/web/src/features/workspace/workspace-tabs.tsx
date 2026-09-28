import { MaterialFileIcon } from "@renderer/components/material-code-icon";
import {
	featurePageIcons,
	formatFeatureCount,
	type FeaturePageId,
} from "@renderer/components/workbench/feature-navigation";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuTrigger,
} from "@renderer/components/ui/context-menu";
import { TooltipIconButton } from "@renderer/components/ui/tooltip-icon-button";
import { noDragRegionClassName } from "@renderer/lib/platform";
import { cn } from "@renderer/lib/utils";
import { FileDiff, Plus, X } from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useTabDrag } from "./use-tab-drag";

export type WorkspaceTab = { key: string; dirty?: boolean } & (
	| { kind: "file" | "review"; path: string }
	| { kind: "feature"; id: FeaturePageId; title: string; count?: number | undefined }
);

interface WorkspaceTabsProps {
	tabs: readonly WorkspaceTab[];
	activeKey: string | null;
	onSelect: (key: string) => void;
	onClose: (key: string) => void;
	onCloseOthers: (key: string) => void;
	onCloseRight: (key: string) => void;
	onCloseAll: () => void;
	onReorder: (key: string, target: string, edge: "before" | "after") => void;
	onNewTab: () => void;
	label: string;
}

function TabIcon({ tab }: { tab: WorkspaceTab }) {
	const className = "size-3.5 shrink-0 text-text-muted";
	if (tab.kind === "feature") {
		const Icon = featurePageIcons[tab.id];
		return <Icon className={className} aria-hidden="true" />;
	}
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
	onSelect,
	onClose,
	onCloseOthers,
	onCloseRight,
	onCloseAll,
	onReorder,
	onNewTab,
	label: groupLabel,
}: WorkspaceTabsProps) {
	const { t } = useTranslation();
	const closeHintId = useId();
	const hasActiveTab = tabs.some((tab) => tab.key === activeKey);
	const stripRef = useRef<HTMLDivElement>(null);
	const tabDrag = useTabDrag(
		stripRef,
		tabs.map((tab) => tab.key),
		onReorder,
	);
	const { drag, drop } = tabDrag;
	useEffect(() => {
		const strip = stripRef.current;
		if (!strip) return;
		const revealActiveTab = () =>
			strip
				.querySelector<HTMLElement>('[aria-selected="true"]')
				?.scrollIntoView({ block: "nearest", inline: "nearest" });
		revealActiveTab();
		// The split or window can shrink without changing the selected tab.
		const observer = new ResizeObserver(revealActiveTab);
		observer.observe(strip);
		return () => observer.disconnect();
	}, [activeKey, tabs.length]);
	const label = (tab: WorkspaceTab) => (tab.kind === "feature" ? tab.title : tab.path.split(/[/\\]/).at(-1)!);
	const title = (tab: WorkspaceTab) =>
		tab.kind === "feature"
			? tab.title
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
				aria-label={groupLabel}
				className="flex min-w-0 items-center gap-1 overflow-x-auto py-1 [scrollbar-width:none]"
			>
				{tabs.map((tab, index) => {
					const active = tab.key === activeKey;
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
									onClick={(event) => {
										if ((event.target as HTMLElement).closest("[data-tab-close]")) onClose(tab.key);
										else if (!tabDrag.consumeDragClick()) onSelect(tab.key);
									}}
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
										"group relative isolate flex h-9 max-w-56 min-w-0 shrink-0 cursor-default select-none items-center gap-1.5 rounded-control px-2.5 text-ui text-text-muted hover:bg-surface-hover/70 hover:text-text-primary focus-visible:bg-surface-hover focus-visible:text-text-primary",
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
									<span className="min-w-0 flex-1 truncate">{label(tab)}</span>
									{tab.kind === "feature" && tab.count !== undefined && tab.count > 0 && (
										<span className="shrink-0 text-xs tabular-nums text-text-muted group-aria-selected:text-text-primary">
											{formatFeatureCount(tab.count)}
										</span>
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
							</ContextMenuContent>
						</ContextMenu>
					);
				})}
			</div>
			<TooltipIconButton label={t("reading.newTab")} onClick={onNewTab}>
				<Plus className="size-4" aria-hidden="true" />
			</TooltipIconButton>
			<div className="min-w-2 flex-1" />
		</div>
	);
}
