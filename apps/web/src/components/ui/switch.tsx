import { cn } from "@renderer/lib/utils";
import { LoaderCircle } from "lucide-react";
import type { ComponentProps } from "react";

interface SwitchProps extends Omit<ComponentProps<"button">, "onChange" | "value"> {
	checked: boolean;
	pending?: boolean;
	onCheckedChange: (checked: boolean) => void;
}

export function Switch({ checked, pending = false, onCheckedChange, className, disabled, ...props }: SwitchProps) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			aria-busy={pending || undefined}
			aria-disabled={disabled || pending || undefined}
			disabled={disabled && !pending}
			onClick={() => {
				if (!disabled && !pending) onCheckedChange(!checked);
			}}
			className={cn(
				"group relative inline-flex h-6 w-10 shrink-0 items-center rounded-full transition-colors aria-disabled:cursor-not-allowed aria-disabled:opacity-50",
				checked ? "bg-choice-selected" : "bg-text-muted/25",
				className,
			)}
			{...props}
		>
			<span
				className={cn(
					"pointer-events-none flex size-4 items-center justify-center rounded-full shadow-(--shadow-control) transition-transform duration-150 ease-out motion-reduce:transition-none",
					checked
						? "translate-x-5 bg-choice-selected-foreground text-choice-selected"
						: "translate-x-1 bg-surface text-text-primary",
				)}
			>
				{pending ? (
					<LoaderCircle className="size-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />
				) : (
					<span
						aria-hidden="true"
						className="size-1.5 rounded-full bg-current opacity-0 group-focus-visible:opacity-100"
					/>
				)}
			</span>
		</button>
	);
}
