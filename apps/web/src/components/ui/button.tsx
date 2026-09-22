import { cn } from "@renderer/lib/utils";
import type { ComponentProps } from "react";

const buttonBase =
	"inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-control text-ui font-medium transition-[background-color,border-color,color,box-shadow,opacity,transform] active:scale-[var(--choice-press-scale)] motion-reduce:active:scale-100 disabled:pointer-events-none disabled:scale-100 disabled:opacity-45";

const buttonVariants = {
	default:
		"bg-btn-primary text-btn-primary-foreground shadow-(--shadow-control) hover:bg-btn-primary-hover focus-visible:bg-btn-primary-hover",
	outline:
		"skin-surface border border-border-subtle bg-surface text-text-primary shadow-(--shadow-control) hover:bg-surface-raised focus-visible:bg-surface-raised",
	ghost: "bg-transparent text-text-primary hover:bg-surface-hover focus-visible:bg-surface-hover",
	danger: "bg-danger text-danger-foreground hover:opacity-90 focus-visible:opacity-90",
};

const buttonSizes = {
	sm: "h-7 px-2.5 text-xs",
	default: "h-8 px-3",
	icon: "h-8 w-8",
};

interface ButtonProps extends ComponentProps<"button"> {
	variant?: keyof typeof buttonVariants | null;
	size?: keyof typeof buttonSizes | null;
}

export function Button({ className, variant = "default", size = "default", ...props }: ButtonProps) {
	return (
		<button
			data-slot="button"
			className={cn(
				buttonBase,
				variant === null ? undefined : buttonVariants[variant],
				size === null ? undefined : buttonSizes[size],
				className,
			)}
			{...props}
		/>
	);
}
