import { cn } from "@renderer/lib/utils";
import type { ComponentProps } from "react";

export function Input({ className, ...props }: ComponentProps<"input">) {
	return (
		<input
			data-slot="input"
			className={cn(
				"h-8 w-full rounded-control border border-border-subtle aria-invalid:border-danger bg-input px-2.5 text-ui text-text-primary shadow-(--shadow-input) transition-colors",
				"placeholder:text-text-muted disabled:cursor-not-allowed disabled:opacity-50",
				className,
			)}
			{...props}
		/>
	);
}
