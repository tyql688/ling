import { cn } from "@renderer/lib/utils";
import { Check, LoaderCircle } from "lucide-react";
import type { ComponentProps } from "react";

interface ChoiceButtonProps extends ComponentProps<"button"> {
	selected: boolean;
	pending?: boolean;
	/** Suppress press feedback in surfaces where movement would distract. */
	static?: boolean;
}

/** One skin-owned treatment for single and multiple choice controls. */
export function ChoiceButton({
	selected,
	pending = false,
	static: isStatic = false,
	children,
	className,
	disabled,
	onClick,
	...props
}: ChoiceButtonProps) {
	return (
		<button
			{...props}
			type="button"
			aria-pressed={selected}
			aria-busy={pending || props["aria-busy"]}
			aria-disabled={disabled || pending || props["aria-disabled"]}
			disabled={disabled && !pending}
			onClick={(event) => {
				if (!pending && !disabled) onClick?.(event);
			}}
			className={cn(
				"inline-flex min-h-10 min-w-0 max-w-full items-center gap-2 rounded-choice border border-transparent px-3.5 py-2 text-ui font-medium focus-visible:underline focus-visible:decoration-2 focus-visible:underline-offset-4 disabled:cursor-not-allowed disabled:opacity-45 pointer-coarse:min-h-11",
				// Brief, interruptible feedback honors both skin motion and system reduced motion.
				!isStatic &&
					"transition-transform duration-150 ease-[cubic-bezier(0.2,0,0,1)] enabled:active:scale-[var(--choice-press-scale)] motion-reduce:transition-none motion-reduce:enabled:active:scale-100",
				selected
					? "bg-choice-selected text-choice-selected-foreground shadow-(--shadow-choice)"
					: "border-border-subtle bg-surface-raised text-text-muted enabled:hover:bg-choice-hover enabled:hover:text-text-primary enabled:focus-visible:bg-choice-hover enabled:focus-visible:text-text-primary",
				className,
			)}
		>
			{children}
			{/* A consistent thin stroke keeps the state mark secondary to the option label. */}
			{pending ? (
				<LoaderCircle aria-hidden="true" className="ms-1 size-3.5 shrink-0 animate-spin motion-reduce:animate-none" />
			) : (
				<Check
					aria-hidden="true"
					strokeWidth={1.5}
					className={cn("ms-1 size-3.5 shrink-0", !selected && "invisible")}
				/>
			)}
		</button>
	);
}
