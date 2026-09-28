import { TooltipIconButton } from "@renderer/components/ui/tooltip-icon-button";
import type { ShellSidebarController } from "@renderer/components/use-shell-sidebar";
import { dragRegionClassName, shortcut } from "@renderer/lib/platform";
import { cn } from "@renderer/lib/utils";
import { ArrowLeft, ArrowRight, PanelLeftOpen } from "lucide-react";
import { motion } from "motion/react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { CHROME_TITLEBAR_CLASS } from "../../components/shell-chrome";

export interface NavigationHistory {
	canGoBack: boolean;
	canGoForward: boolean;
	goBack: () => void;
	goForward: () => void;
}

/** Back and forward through session navigation history. */
export function HistoryButtons({ history }: { history: NavigationHistory }) {
	const { t } = useTranslation();
	return (
		<>
			<TooltipIconButton
				onClick={history.goBack}
				label={t("nav.back")}
				disabled={!history.canGoBack}
				className="disabled:opacity-35"
			>
				<ArrowLeft className="size-4" aria-hidden="true" />
			</TooltipIconButton>
			<TooltipIconButton
				onClick={history.goForward}
				label={t("nav.forward")}
				disabled={!history.canGoForward}
				className="disabled:opacity-35"
			>
				<ArrowRight className="size-4" aria-hidden="true" />
			</TooltipIconButton>
		</>
	);
}

interface WorkspaceTitlebarProps {
	sidebar: Pick<
		ShellSidebarController,
		"presentation" | "open" | "previewOpen" | "toggleSidebar" | "schedulePreview" | "schedulePreviewClose"
	>;
	history: NavigationHistory;
	title?: ReactNode;
	reserveWindowControls?: boolean;
	navigation?: boolean;
	tools: ReactNode;
}

/** The current conversation's title and controls share the native window drag region. */
export function WorkspaceTitlebar({
	sidebar,
	history,
	title,
	tools,
	reserveWindowControls = true,
	navigation = true,
}: WorkspaceTitlebarProps) {
	const showSidebarTrigger = navigation && (sidebar.presentation === "sheet" || !sidebar.open);
	return (
		<header
			style={{
				paddingLeft: showSidebarTrigger ? "var(--window-controls-left-padding)" : undefined,
				paddingRight: reserveWindowControls ? "calc(var(--window-controls-right-padding) + 0.5rem)" : "0.5rem",
			}}
			// 44px aligns with the sidebar's traffic-light-safe row and remains available for native window dragging.
			className={cn(
				"relative z-30 flex min-w-0 shrink-0 items-center gap-1.5 pl-3",
				CHROME_TITLEBAR_CLASS,
				dragRegionClassName,
			)}
		>
			{showSidebarTrigger && <WorkspaceNavigationControls sidebar={sidebar} history={history} />}
			<div className="flex min-w-0 flex-1 items-center">{title}</div>
			<div className="flex shrink-0 items-center gap-0.5">{tools}</div>
		</header>
	);
}

/** Native padding is supplied by whichever pane currently owns the left edge. */
export function WorkspaceNavigationControls({ sidebar, history }: Pick<WorkspaceTitlebarProps, "sidebar" | "history">) {
	const { t } = useTranslation();
	const sidebarLabel =
		sidebar.presentation === "sheet"
			? t("nav.openSidebar")
			: sidebar.previewOpen
				? t("nav.pinSidebar")
				: sidebar.open
					? t("nav.closeSidebar")
					: t("nav.openSidebar");
	if (sidebar.presentation !== "sheet" && sidebar.open) return null;
	return (
		<motion.div
			className="flex shrink-0 items-center gap-0.5"
			initial={{ opacity: 0 }}
			animate={{ opacity: 1 }}
			transition={{ delay: 0.15, duration: 0.12 }}
		>
			<TooltipIconButton
				data-shell-sidebar-trigger=""
				onClick={sidebar.toggleSidebar}
				onPointerEnter={sidebar.schedulePreview}
				onPointerLeave={sidebar.schedulePreviewClose}
				label={sidebarLabel}
				shortcut={shortcut("B")}
			>
				<PanelLeftOpen className="size-4" aria-hidden="true" />
			</TooltipIconButton>
			<HistoryButtons history={history} />
		</motion.div>
	);
}
