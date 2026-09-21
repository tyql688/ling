import { NavigationItem } from "@renderer/components/ui/navigation-item";
import { lastConversationCwdAtom, openProjectsAtom } from "@renderer/features/projects/state";
import { activeSessionRefAtom } from "@renderer/features/sessions/state/session";
import { type SettingsCategory, settingsCategoryAtom } from "@renderer/lib/navigation-state";
import { CHROME_TITLEBAR_CLASS } from "@renderer/components/shell-chrome";
import { ShellFrame } from "@renderer/components/shell-frame";
import { Button } from "@renderer/components/ui/button";
import { LoadingTransition } from "@renderer/components/ui/loading-transition";
import { TooltipIconButton } from "@renderer/components/ui/tooltip-icon-button";
import { useShellSidebar } from "@renderer/components/use-shell-sidebar";
import type { ThemeController } from "@renderer/lib/appearance/use-theme";
import { dragRegionClassName, noDragRegionClassName } from "@renderer/lib/platform";
import { cn } from "@renderer/lib/utils";
import { useAtom, useAtomValue } from "jotai";
import {
	Activity,
	ArrowLeft,
	Boxes,
	ChartColumn,
	GraduationCap,
	Palette,
	PanelLeftClose,
	PanelLeftOpen,
	Pi,
	Puzzle,
	ShieldCheck,
	SlidersHorizontal,
	SquareTerminal,
} from "lucide-react";
import { motion } from "motion/react";
import { Fragment, lazy, Suspense, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useDomainApi } from "@renderer/lib/host-api-context";
const AppearanceView = lazy(() =>
	import("./appearance-view").then(({ AppearanceView }) => ({ default: AppearanceView })),
);
const PiSettingsView = lazy(() =>
	import("./pi-settings-view").then(({ PiSettingsView }) => ({ default: PiSettingsView })),
);
const PermissionsSettingsView = lazy(() =>
	import("@renderer/features/pi-adapters/permission-system/permissions-settings-view").then(
		({ PermissionsSettingsView }) => ({ default: PermissionsSettingsView }),
	),
);
const SettingsView = lazy(() => import("./settings-view").then(({ SettingsView }) => ({ default: SettingsView })));
const TerminalSettingsView = lazy(() =>
	import("./terminal-settings-view").then(({ TerminalSettingsView }) => ({ default: TerminalSettingsView })),
);
const ModelsView = lazy(() =>
	import("@renderer/features/models/models-view").then(({ ModelsView }) => ({ default: ModelsView })),
);
const PluginsView = lazy(() =>
	import("@renderer/features/plugins/plugins-view").then(({ PluginsView }) => ({ default: PluginsView })),
);
const SkillsView = lazy(() =>
	import("@renderer/features/skills/skills-view").then(({ SkillsView }) => ({ default: SkillsView })),
);
const UsageView = lazy(() =>
	import("@renderer/features/usage/usage-view").then(({ UsageView }) => ({ default: UsageView })),
);
const DiagnosticsView = lazy(() =>
	import("./diagnostics-view").then(({ DiagnosticsView }) => ({ default: DiagnosticsView })),
);

// Traffic lights are a window-level setting (see main/index.ts) — they render at a fixed
// physical position regardless of which screen is showing, so every full-screen mode (this one
// included) must reserve the same 44px-tall drag region or they'll overlap real content.

/** Settings sidebar category table: order equals navigation order, with each id/labelKey/icon triple defined once. */
const CATEGORIES: { id: SettingsCategory; labelKey: string; icon: typeof SlidersHorizontal }[] = [
	{ id: "general", labelKey: "settings.general", icon: SlidersHorizontal },
	{ id: "appearance", labelKey: "settings.appearance", icon: Palette },
	{ id: "terminal", labelKey: "settings.terminal", icon: SquareTerminal },
	{ id: "pi", labelKey: "settings.pi", icon: Pi },
	{ id: "models", labelKey: "settings.models", icon: Boxes },
	{ id: "plugins", labelKey: "nav.plugins", icon: Puzzle },
	{ id: "skills", labelKey: "skills.title", icon: GraduationCap },
	{ id: "permissions", labelKey: "permissions.title", icon: ShieldCheck },
	{ id: "usage", labelKey: "settings.usage", icon: ChartColumn },
	{ id: "diagnostics", labelKey: "settings.diagnostics", icon: Activity },
];

interface SettingsShellProps {
	onBack: () => void;
	themeController: ThemeController;
}

export function SettingsShell({ onBack, themeController }: SettingsShellProps) {
	const { capabilities } = useDomainApi("ui");
	const activeSessionRef = useAtomValue(activeSessionRefAtom);
	const projects = useAtomValue(openProjectsAtom);
	const lastConversationCwd = useAtomValue(lastConversationCwdAtom);
	// Project/package providers require a cwd, while Settings can open from the home screen
	// without an active session. Match the home composer's deterministic project fallback.
	const providerProjectCwd =
		activeSessionRef?.cwd ??
		projects.find((project) => project.cwd === lastConversationCwd)?.cwd ??
		projects[0]?.cwd ??
		null;
	const { t } = useTranslation();
	const [category, setCategory] = useAtom(settingsCategoryAtom);
	const shellSidebar = useShellSidebar({ dockedCollapsed: false });
	const selectCategory = (next: SettingsCategory) => {
		setCategory(next);
		shellSidebar.dismissSheet();
	};
	const showSidebarTrigger = shellSidebar.presentation === "sheet";
	const activeCategory = CATEGORIES.find((item) => item.id === category);
	// Content slides in from the direction of travel along the nav order (down the list → from below).
	const categoryIndex = CATEGORIES.findIndex((item) => item.id === category);
	const previousIndexRef = useRef(categoryIndex);
	const direction = categoryIndex >= previousIndexRef.current ? 1 : -1;
	useEffect(() => {
		previousIndexRef.current = categoryIndex;
	}, [categoryIndex]);

	return (
		<ShellFrame
			sidebarLabel={t("settings.navigation")}
			sidebarController={shellSidebar}
			contentClassName={
				category === "usage" ? "workspace-scene scene-surface usage-reading-frame" : "reading-glass-frame"
			}
			titlebar={
				showSidebarTrigger ? (
					<header
						style={{
							paddingLeft: "var(--window-controls-left-padding)",
							paddingRight: "var(--window-controls-right-padding)",
						}}
						className={cn(
							"chrome-glass flex shrink-0 items-center gap-2 bg-header",
							CHROME_TITLEBAR_CLASS,
							dragRegionClassName,
						)}
					>
						<div className="flex min-w-0 flex-1 items-center gap-2">
							<TooltipIconButton
								data-shell-sidebar-trigger=""
								onClick={shellSidebar.openSidebar}
								label={t("nav.openSidebar")}
								className={noDragRegionClassName}
							>
								<PanelLeftOpen className="size-4" aria-hidden="true" />
							</TooltipIconButton>
							<span className="truncate text-ui font-medium text-text-primary">
								{activeCategory ? t(activeCategory.labelKey) : t("nav.settings")}
							</span>
						</div>
					</header>
				) : undefined
			}
			sidebar={
				<div className="flex h-full min-w-0 flex-col">
					<div
						style={{ paddingLeft: "var(--window-controls-left-padding)" }}
						className={cn("flex shrink-0 items-center pr-2", CHROME_TITLEBAR_CLASS, dragRegionClassName)}
					>
						<span className="sr-only">{t("nav.settings")}</span>
						{showSidebarTrigger && (
							<TooltipIconButton
								onClick={shellSidebar.closeSidebar}
								label={t("nav.closeSidebar")}
								className={cn("ml-auto", noDragRegionClassName)}
							>
								<PanelLeftClose className="size-4" aria-hidden="true" />
							</TooltipIconButton>
						)}
					</div>
					<nav className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 py-3">
						{CATEGORIES.map((item) => (
							<Fragment key={item.id}>
								{(item.id === "general" || item.id === "pi" || item.id === "usage") && (
									<h2 className="px-2.5 pt-4 pb-2 text-xs font-medium text-text-muted">
										{t(
											item.id === "general"
												? "settings.groupApp"
												: item.id === "pi"
													? "settings.groupAgent"
													: "settings.groupData",
										)}
									</h2>
								)}
								<NavigationItem
									size="sm"
									type="button"
									aria-current={category === item.id ? "page" : undefined}
									onClick={() => selectCategory(item.id)}
									className={cn(
										"relative aria-current:bg-transparent",
										category === item.id
											? "text-text-primary"
											: "text-text-muted hover:bg-surface-hover hover:text-text-primary",
									)}
								>
									{category === item.id && (
										<motion.span
											layoutId="settings-nav-active"
											aria-hidden="true"
											className="absolute inset-0 rounded-control bg-surface-hover"
											transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
										/>
									)}
									<item.icon
										className={cn(
											"relative size-4 shrink-0",
											category === item.id ? "text-text-primary" : "text-text-muted",
										)}
										aria-hidden="true"
									/>
									<span className="relative">{t(item.labelKey)}</span>
								</NavigationItem>
							</Fragment>
						))}
					</nav>
					<div className="border-t border-border-subtle p-2">
						<Button
							variant="ghost"
							size="sm"
							onClick={() => {
								shellSidebar.dismissSheet();
								onBack();
							}}
							className={cn(
								"h-9 w-full justify-start rounded-control text-text-muted hover:text-text-primary",
								noDragRegionClassName,
							)}
						>
							<ArrowLeft className="size-4" aria-hidden="true" />
							{t("settings.backToWorkspace")}
						</Button>
					</div>
				</div>
			}
		>
			{!showSidebarTrigger && (
				<div
					style={{ height: "var(--window-controls-height)" }}
					className={cn("absolute inset-x-0 top-0 z-30", dragRegionClassName)}
				/>
			)}
			<motion.div
				key={category}
				// Six pixels communicate direction without making each category feel like a page turn.
				initial={{ opacity: 0, y: 6 * direction }}
				animate={{ opacity: 1, y: 0 }}
				transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
				className="min-h-0 flex-1"
			>
				<Suspense fallback={<LoadingTransition label={t("settings.loading")} className="h-full" />}>
					{category === "general" && <SettingsView />}
					{category === "appearance" && <AppearanceView themeController={themeController} />}
					{category === "terminal" && <TerminalSettingsView />}
					{category === "pi" && <PiSettingsView />}
					{category === "models" && <ModelsView providerProjectCwd={providerProjectCwd} />}
					{category === "plugins" && <PluginsView />}
					{category === "skills" && <SkillsView />}
					{category === "usage" && <UsageView />}
					{category === "diagnostics" && <DiagnosticsView />}
					{category === "permissions" && (
						<PermissionsSettingsView
							projects={projects}
							activeCwd={providerProjectCwd}
							nativePathOpen={capabilities.nativePathOpen}
						/>
					)}
				</Suspense>
			</motion.div>
		</ShellFrame>
	);
}
