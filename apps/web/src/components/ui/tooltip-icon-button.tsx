import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { IconButton } from "./icon-button";
import type { ComponentPropsWithRef, ReactNode } from "react";

interface TooltipIconButtonProps extends Omit<ComponentPropsWithRef<"button">, "children" | "aria-label"> {
	/** Accessible name; also the tooltip's first segment. */
	label: string;
	/** Optional keyboard shortcut shown with the shared tooltip treatment. */
	shortcut?: string | undefined;
	tooltipSide?: "top" | "right" | "bottom" | "left" | undefined;
	/** The icon element. */
	children: ReactNode;
}

/** Accessible name and tooltip share one label; IconButton owns the action treatment. */
export function TooltipIconButton({
	label,
	shortcut,
	tooltipSide,
	className,
	children,
	style,
	ref,
	...buttonProps
}: TooltipIconButtonProps) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<IconButton ref={ref} type="button" style={style} aria-label={label} className={className} {...buttonProps} />
				}
			>
				{children}
			</TooltipTrigger>
			<TooltipContent shortcut={shortcut} {...(tooltipSide ? { side: tooltipSide } : {})}>
				{label}
			</TooltipContent>
		</Tooltip>
	);
}
