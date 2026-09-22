import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cn } from "@renderer/lib/utils";
import { cloneElement, type ComponentPropsWithRef, type ReactElement, type ReactNode } from "react";

function TooltipProvider({
	delayDuration = 480,
	skipDelayDuration = 0,
	disableHoverableContent = true,
	...props
}: TooltipPrimitive.TooltipProviderProps) {
	return (
		<TooltipPrimitive.Provider
			delayDuration={delayDuration}
			skipDelayDuration={skipDelayDuration}
			disableHoverableContent={disableHoverableContent}
			{...props}
		/>
	);
}

function Tooltip(props: TooltipPrimitive.TooltipProps) {
	return <TooltipPrimitive.Root {...props} />;
}

/**
 * The tooltip's pure visual surface. Both the Radix popover and chart hints that position
 * themselves reuse it, so corner radius, colors, padding, and shadow don't drift across features.
 */
function TooltipSurface({ className, ...props }: ComponentPropsWithRef<"div">) {
	return (
		<div
			data-slot="tooltip-surface"
			className={cn(
				"glass-surface floating-surface pointer-events-none w-fit max-w-xs select-none rounded-control border border-border-subtle bg-tooltip px-2.5 py-1.5 text-xs font-medium text-tooltip-foreground shadow-(--shadow-floating)",
				className,
			)}
			{...props}
		/>
	);
}

/**
 * Keeps the base-ui-era call sites working on radix: `render={<button …/>}` becomes the
 * `asChild` child, with the trigger's children merged into it.
 */
function TooltipTrigger({
	render,
	children,
}: {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- accepts any host element to merge children into
	render?: ReactElement<any>;
	children?: ReactNode;
}) {
	const trigger = render ? (
		children === undefined ? (
			render
		) : (
			cloneElement(render, undefined, children)
		)
	) : (
		<span>{children}</span>
	);
	return <TooltipPrimitive.Trigger asChild>{trigger}</TooltipPrimitive.Trigger>;
}

interface TooltipContentProps extends TooltipPrimitive.TooltipContentProps {
	/** Optional keyboard shortcut rendered with the shared label treatment. */
	shortcut?: string | undefined;
}

function TooltipContent({
	className,
	side = "top",
	sideOffset = 6,
	align = "center",
	children,
	shortcut,
	...props
}: TooltipContentProps) {
	return (
		<TooltipPrimitive.Portal>
			<TooltipPrimitive.Content
				data-slot="tooltip-content"
				side={side}
				sideOffset={sideOffset}
				align={align}
				// Anchors move without scroll/resize here (the sidebar width animation slides the
				// whole title bar), and the default "optimized" strategy never re-anchors, leaving
				// the tooltip floating where the trigger used to be. Tooltips are transient, so
				// per-frame tracking while open is cheap.
				updatePositionStrategy="always"
				className={cn(
					"pointer-events-none data-[state=closed]:animate-out data-[state=delayed-open]:animate-in data-[state=closed]:fade-out-0 data-[state=delayed-open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=delayed-open]:zoom-in-95",
					"data-[side=bottom]:slide-in-from-top-1 data-[side=top]:slide-in-from-bottom-1",
					"z-50 duration-100 motion-reduce:animate-none",
				)}
				{...props}
			>
				<TooltipSurface className={className}>
					{shortcut === undefined ? (
						children
					) : (
						<span className="inline-flex items-center gap-2 whitespace-nowrap">
							<span>{children}</span>
							<kbd className="rounded-sm border border-border-subtle bg-surface-hover px-1.5 py-0.5 font-mono text-xs font-normal leading-none text-text-muted shadow-[inset_0_1px_0_rgb(255_255_255/0.08)]">
								{shortcut}
							</kbd>
						</span>
					)}
				</TooltipSurface>
				<TooltipPrimitive.Arrow
					width={10}
					height={5}
					className="fill-tooltip drop-shadow-[0_1px_0_var(--color-border-subtle)]"
				/>
			</TooltipPrimitive.Content>
		</TooltipPrimitive.Portal>
	);
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipSurface, TooltipTrigger };
