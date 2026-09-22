import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@renderer/components/ui/dialog";
import { cn } from "@renderer/lib/utils";
import type { ComponentProps, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";

interface WorkbenchDialogProps {
	open: boolean;
	nestedDialogOpen: boolean;
	title: string;
	description: string;
	onOpenChange: (open: boolean) => void;
	onCloseAutoFocus?: ComponentProps<typeof DialogContent>["onCloseAutoFocus"];
	containerClassName?: string | undefined;
	panelClassName?: string | undefined;
	/** Render inline inside the workspace side panel instead of as a floating dialog. */
	docked?: boolean | undefined;
	children: ReactNode;
}

/**
 * Keeps project navigation and the conversation layout stationary while temporary
 * work surfaces float above the active workspace. The dialog is portalled into the
 * workbench host so it never covers the persistent project sidebar or title bar.
 */
export function WorkbenchDialog({
	open,
	nestedDialogOpen,
	title,
	description,
	onOpenChange,
	onCloseAutoFocus,
	containerClassName,
	panelClassName,
	docked = false,
	children,
}: WorkbenchDialogProps) {
	const panelRef = useRef<HTMLDivElement>(null);
	// Mount content two frames late: synchronous rendering of the file tree/preview/diff is expensive
	// and drops frames when committed in the same frame as the entry animation.
	// Let the empty-shell animation (fade+rise) start first, then fade the content in — a naturally layered entrance.
	const [contentReady, setContentReady] = useState(open);
	useEffect(() => {
		if (!open) {
			setContentReady(false);
			return;
		}
		let second = 0;
		const first = requestAnimationFrame(() => {
			second = requestAnimationFrame(() => setContentReady(true));
		});
		// rAF doesn't fire while the window is occluded/backgrounded — the timeout fallback guarantees the content appears.
		const fallback = window.setTimeout(() => setContentReady(true), 120);
		return () => {
			cancelAnimationFrame(first);
			cancelAnimationFrame(second);
			window.clearTimeout(fallback);
		};
	}, [open]);

	if (docked) {
		if (!open) return null;
		return (
			<div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", containerClassName)} data-workbench-docked="">
				<span className="sr-only">{title}</span>
				{contentReady && (
					<div className="flex min-h-0 flex-1 animate-in flex-col duration-150 fade-in motion-reduce:animate-none">
						{children}
					</div>
				)}
			</div>
		);
	}
	return (
		<div className={cn("workbench-dialog-container absolute inset-0 z-40", !open && "pointer-events-none")}>
			<Dialog open={open} onOpenChange={onOpenChange}>
				<DialogContent
					ref={panelRef}
					variant="workspace"
					portalled={false}
					overlayClassName="!absolute z-40 bg-surface-under/55 backdrop-blur-[3px]"
					className={cn("workbench-dialog flex flex-col overflow-hidden p-0", containerClassName, panelClassName)}
					tabIndex={-1}
					onEscapeKeyDown={(event) => {
						if (nestedDialogOpen) event.preventDefault();
					}}
					onCloseAutoFocus={onCloseAutoFocus}
					onOpenAutoFocus={(event) => {
						event.preventDefault();
						panelRef.current?.focus({ preventScroll: true });
					}}
					onInteractOutside={(event) => {
						if (nestedDialogOpen) event.preventDefault();
					}}
				>
					<DialogTitle className="sr-only">{title}</DialogTitle>
					<DialogDescription className="sr-only">{description}</DialogDescription>
					{contentReady && (
						<div className="flex min-h-0 flex-1 animate-in flex-col duration-150 fade-in motion-reduce:animate-none">
							{children}
						</div>
					)}
				</DialogContent>
			</Dialog>
		</div>
	);
}
