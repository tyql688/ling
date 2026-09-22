import { cn } from "@renderer/lib/utils";
import type { ComponentProps } from "react";

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
	return (
		<textarea
			data-slot="textarea"
			className={cn(
				"w-full rounded-control border border-border-subtle aria-invalid:border-danger bg-input px-3 py-2 text-ui text-text-primary shadow-(--shadow-input) transition-colors placeholder:text-text-muted disabled:cursor-not-allowed disabled:opacity-50",
				className,
			)}
			{...props}
		/>
	);
}
