import { cn } from "@renderer/lib/utils";
import type { ComponentProps } from "react";

export function Input({ className, ...props }: ComponentProps<"input">) {
	return (
		<input
			data-slot="input"
			className={cn(
				"h-9 w-full rounded-control border border-border-subtle aria-invalid:border-danger bg-input px-3 text-sm text-text-primary transition-colors",
				"placeholder:text-text-muted disabled:cursor-not-allowed disabled:opacity-50",
				className,
			)}
			{...props}
		/>
	);
}
