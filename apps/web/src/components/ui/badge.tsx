import { STATUS_PRESENTATION } from "./status-presentation";
import { cn } from "@renderer/lib/utils";
import type { ComponentProps } from "react";

const badgeBase = "inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium";

const badgeVariants = {
	default: STATUS_PRESENTATION.neutral.surface,
	accent: "bg-accent-muted text-accent",
	danger: STATUS_PRESENTATION.error.surface,
	success: STATUS_PRESENTATION.success.surface,
};

interface BadgeProps extends ComponentProps<"span"> {
	variant?: keyof typeof badgeVariants | null;
}

export function Badge({ className, variant = "default", ...props }: BadgeProps) {
	return (
		<span className={cn(badgeBase, variant === null ? undefined : badgeVariants[variant], className)} {...props} />
	);
}
