import {
	CHROME_CONTENT_REGION_CLASS,
	CHROME_SIDEBAR_SHEET_CLASS,
	CHROME_SIDEBAR_WIDTH_CLASS,
} from "@renderer/components/shell-chrome";
import { Dialog, DialogContent, DialogTitle } from "@renderer/components/ui/dialog";
import { cn } from "@renderer/lib/utils";
import type { ReactNode } from "react";
import { useEffect, useLayoutEffect, useRef } from "react";
import type { ShellSidebarController } from "./use-shell-sidebar";

/** Sidebar surface data selector: shared by the focus trap and click-outside close, so magic strings don't diverge. */
const SIDEBAR_SURFACE_SELECTOR = "[data-shell-sidebar-surface]";
/** Sidebar trigger button selector: returns focus to the trigger when the sheet closes. */
const SIDEBAR_TRIGGER_SELECTOR = "[data-shell-sidebar-trigger]";
/** Union selector of focusable elements inside the sheet; Tab cycling and initial focus only trust this list. */
const FOCUSABLE_SELECTOR = [
	"button:not([disabled])",
	"a[href]",
	"input:not([disabled])",
	"select:not([disabled])",
	"textarea:not([disabled])",
	"[tabindex]:not([tabindex='-1'])",
].join(",");

interface ShellFrameProps {
	/** The right region's 44px chrome row; the sidebar owns its matching row. */
	titlebar?: ReactNode;
	sidebar: ReactNode;
	sidebarLabel: string;
	sidebarController: ShellSidebarController;
	children: ReactNode;
	contentClassName?: string | undefined;
	/** One continuous scene behind the workspace titlebar and its content. */
	scene?: boolean;
}

function useSidebarFocusHandoff(sidebarController: ShellSidebarController) {
	const mainRef = useRef<HTMLElement | null>(null);
	const sidebarHadFocusRef = useRef(false);
	const previousStateRef = useRef({
		presentation: sidebarController.presentation,
		open: sidebarController.visible,
	});

	useEffect(() => {
		const handleFocusIn = (event: FocusEvent) => {
			const target = event.target;
			sidebarHadFocusRef.current = target instanceof Element && target.closest(SIDEBAR_SURFACE_SELECTOR) !== null;
		};
		document.addEventListener("focusin", handleFocusIn);
		return () => document.removeEventListener("focusin", handleFocusIn);
	}, []);

	useLayoutEffect(() => {
		const previous = previousStateRef.current;
		previousStateRef.current = {
			presentation: sidebarController.presentation,
			open: sidebarController.visible,
		};
		const surfaceWasReplaced = previous.presentation !== sidebarController.presentation;
		const focusedSurfaceClosed = previous.open && !sidebarController.visible;
		if (!sidebarHadFocusRef.current || (!surfaceWasReplaced && !focusedSurfaceClosed)) return undefined;

		const frame = requestAnimationFrame(() => {
			let destination: HTMLElement | null = null;
			if (sidebarController.visible) {
				destination =
					document
						.querySelector<HTMLElement>(SIDEBAR_SURFACE_SELECTOR)
						?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR) ?? null;
			}
			destination ??= document.querySelector<HTMLElement>(SIDEBAR_TRIGGER_SELECTOR);
			destination ??= mainRef.current;
			sidebarHadFocusRef.current = false;
			destination?.focus({ preventScroll: true });
		});
		return () => cancelAnimationFrame(frame);
	}, [sidebarController.presentation, sidebarController.visible]);

	return mainRef;
}

export function ShellFrame({
	titlebar,
	sidebar,
	sidebarLabel,
	sidebarController,
	children,
	contentClassName,
	scene = false,
}: ShellFrameProps) {
	const mainRef = useSidebarFocusHandoff(sidebarController);
	const dockedOpen = sidebarController.presentation === "docked" && sidebarController.open;
	return (
		// Percentage sizing follows the browser shell's CSS zoom; viewport units remain unscaled.
		<div className="relative flex h-full w-full text-text-primary">
			{/* The window has exactly two first-level regions. Each region owns its own
			    44px safe row, so native dragging never becomes a third visual layer. */}
			{sidebarController.presentation === "docked" ? (
				<div
					className={cn(
						"relative h-full shrink-0 transition-[width] duration-200 ease-out motion-reduce:transition-none",
						dockedOpen ? CHROME_SIDEBAR_WIDTH_CLASS : "w-0",
					)}
				>
					<aside
						data-shell-sidebar-surface=""
						data-shell-sidebar-preview={sidebarController.previewOpen ? "" : undefined}
						aria-label={sidebarLabel}
						aria-hidden={!sidebarController.visible}
						inert={!sidebarController.visible}
						onPointerEnter={sidebarController.keepPreviewOpen}
						onPointerLeave={sidebarController.schedulePreviewClose}
						onFocusCapture={sidebarController.keepPreviewOpen}
						className={cn(
							"sidebar-glass absolute inset-y-0 left-0 z-40 flex flex-col overflow-hidden",
							"transition-[transform,opacity] duration-200 ease-out motion-reduce:transition-none",
							CHROME_SIDEBAR_WIDTH_CLASS,
							sidebarController.visible
								? "translate-x-0 opacity-100"
								: "pointer-events-none -translate-x-full opacity-0",
							sidebarController.previewOpen
								? "rounded-r-panel border-border-subtle border-r bg-sidebar-preview shadow-[12px_0_32px_rgb(0_0_0/0.14)]"
								: CHROME_SIDEBAR_SHEET_CLASS,
						)}
					>
						<div className={cn("h-full shrink-0", CHROME_SIDEBAR_WIDTH_CLASS)}>{sidebar}</div>
					</aside>
				</div>
			) : (
				<Dialog open={sidebarController.sheetOpen} onOpenChange={sidebarController.setSheetOpen}>
					<DialogContent variant="left-sheet" className="w-[min(20rem,calc(100vw-3rem))] p-0">
						<DialogTitle className="sr-only">{sidebarLabel}</DialogTitle>
						<aside data-shell-sidebar-surface="" aria-label={sidebarLabel} className="h-full min-w-0">
							{sidebar}
						</aside>
					</DialogContent>
				</Dialog>
			)}
			<div data-shell-content-region="" className={cn(CHROME_CONTENT_REGION_CLASS, scene && "workspace-scene")}>
				{titlebar}
				<main
					ref={mainRef}
					tabIndex={-1}
					data-dialog-focus-fallback=""
					className={cn("flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden", contentClassName)}
				>
					{children}
				</main>
			</div>
		</div>
	);
}
