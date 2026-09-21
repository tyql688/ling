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
				"group relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50",
				checked ? "bg-text-primary" : "bg-text-muted/35",
				className,
			)}
			{...props}
		>
			<span
				className={cn(
					// Overshoot ease so the thumb lands with a little bounce; pressing squashes it like a real toggle.
					"pointer-events-none size-4 rounded-full bg-surface shadow-sm transition-transform duration-200 ease-[cubic-bezier(0.34,1.56,0.64,1)] group-active:scale-x-[1.2] motion-reduce:transition-none",
					checked ? "translate-x-[18px]" : "translate-x-0.5",
				)}
			/>
		</button>
	);
}
