import { cn } from "@renderer/lib/utils";
import type { ComponentProps } from "react";

interface SwitchProps extends Omit<ComponentProps<"button">, "onChange" | "value"> {
	checked: boolean;
	onCheckedChange: (checked: boolean) => void;
}

export function Switch({ checked, onCheckedChange, className, disabled, ...props }: SwitchProps) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			disabled={disabled}
			onClick={() => onCheckedChange(!checked)}
			className={cn(
				"group relative inline-flex h-6 w-10 shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50",
				checked ? "bg-choice-selected" : "bg-text-muted/25",
				className,
			)}
			{...props}
		>
			<span
				className={cn(
					"pointer-events-none size-4 rounded-full shadow-(--shadow-control) transition-transform duration-150 ease-out motion-reduce:transition-none",
					checked ? "translate-x-5 bg-choice-selected-foreground" : "translate-x-1 bg-surface",
				)}
			/>
		</button>
	);
}
