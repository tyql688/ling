import { cn } from "@renderer/lib/utils";
import { Info, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/** Empty successful results share a hierarchy; failures use their recovery owner. */
export function EmptyState({
	variant = "panel",
	icon: Icon = Info,
	title,
	description,
	action,
	className,
}: {
	variant?: "inline" | "panel" | "first-run";
	icon?: LucideIcon;
	title: string;
	description?: ReactNode;
	action?: ReactNode;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"min-w-0 text-text-muted",
				variant === "inline" ? "py-2 text-xs" : "flex flex-col items-center justify-center gap-3 px-6 py-8 text-center",
				variant === "first-run" && "min-h-60",
				className,
			)}
		>
			{variant !== "inline" && <Icon className="size-6" aria-hidden="true" />}
			<p className={cn(variant === "first-run" ? "text-lg font-medium text-text-primary" : "text-sm font-medium")}>
				{title}
			</p>
			{description && <div className="max-w-md text-sm leading-relaxed">{description}</div>}
			{action && <div className="mt-2">{action}</div>}
		</div>
	);
}
