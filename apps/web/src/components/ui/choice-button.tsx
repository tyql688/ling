import { cn } from "@renderer/lib/utils";
import { Check } from "lucide-react";
import type { ComponentProps } from "react";

interface ChoiceButtonProps extends ComponentProps<"button"> {
	selected: boolean;
	/** Suppress press feedback in surfaces where movement would distract. */
	static?: boolean;
}

/** One skin-owned treatment for single and multiple choice controls. */
export function ChoiceButton({ selected, static: isStatic = false, children, className, ...props }: ChoiceButtonProps) {
	return (
		<button
			{...props}
			type="button"
			aria-pressed={selected}
			className={cn(
				"inline-flex min-h-10 min-w-0 max-w-full items-center gap-2 rounded-choice px-3.5 py-2 text-xs font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-45 pointer-coarse:min-h-11",
				// Brief, interruptible feedback honors both skin motion and system reduced motion.
				!isStatic &&
					"transition-transform duration-150 ease-[cubic-bezier(0.2,0,0,1)] enabled:active:scale-[var(--choice-press-scale)] motion-reduce:transition-none motion-reduce:enabled:active:scale-100",
				selected
					? "bg-choice-selected text-choice-selected-foreground shadow-choice"
					: "bg-surface-raised text-text-muted ring-1 ring-inset ring-border-subtle enabled:hover:bg-choice-hover enabled:hover:text-text-primary",
				className,
			)}
		>
			{children}
			{/* A consistent thin stroke keeps the state mark secondary to the option label. */}
			<Check aria-hidden="true" strokeWidth={1.5} className={cn("ms-1 size-3.5 shrink-0", !selected && "invisible")} />
		</button>
	);
}
