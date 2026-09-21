import type { ComponentProps, ReactNode } from "react";
import { cn } from "@renderer/lib/utils";

export function NavigationItem({
	icon,
	size = "default",
	className,
	children,
	...props
}: ComponentProps<"button"> & { icon?: ReactNode; size?: "default" | "sm" }) {
	return (
		<button
			type="button"
			className={cn(
				"flex h-10 w-full min-w-0 cursor-default items-center gap-3 rounded-control px-3 text-left text-ui font-medium text-text-primary transition-colors hover:bg-surface-hover focus-visible:bg-surface-hover aria-current:bg-surface-hover disabled:pointer-events-none disabled:opacity-35",
				size === "sm" &&
					"h-8 gap-2.5 px-2.5 text-sm text-text-muted aria-current:text-text-primary hover:text-text-primary",
				className,
			)}
			{...props}
		>
			{icon && <span className="flex size-4 shrink-0 items-center justify-center [&_svg]:size-4">{icon}</span>}
			{children}
		</button>
	);
}
