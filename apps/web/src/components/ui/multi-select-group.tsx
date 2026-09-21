import { cn } from "@renderer/lib/utils";
import type { ComponentProps, ReactNode } from "react";
import { ChoiceButton } from "./choice-button";

interface MultiSelectOption<Value extends string> {
	value: Value;
	label: string;
	icon?: ReactNode;
	disabled?: boolean;
}

interface MultiSelectGroupProps<Value extends string> extends Omit<ComponentProps<"div">, "children" | "onChange"> {
	options: readonly MultiSelectOption<Value>[];
	value: readonly Value[];
	onValueChange: (value: Value[]) => void;
	disabled?: boolean;
	/** Suppress press feedback in surfaces where movement would distract. */
	static?: boolean;
}

/** Controlled, inline multi-selection with native keyboard activation. Selection,
 * defaults and validation belong to the caller; each option exposes its pressed state. */
export function MultiSelectGroup<Value extends string>({
	options,
	value,
	onValueChange,
	disabled = false,
	static: isStatic = false,
	className,
	...props
}: MultiSelectGroupProps<Value>) {
	return (
		<div {...props} role="group" className={cn("flex min-w-0 flex-wrap gap-2", className)}>
			{options.map((option) => {
				const selected = value.includes(option.value);
				return (
					<ChoiceButton
						key={option.value}
						disabled={disabled || option.disabled}
						selected={selected}
						static={isStatic}
						onClick={() => {
							// Preserve selections outside the currently rendered options.
							onValueChange(selected ? value.filter((entry) => entry !== option.value) : [...value, option.value]);
						}}
					>
						{option.icon && (
							<span aria-hidden="true" className="flex shrink-0 items-center [&_svg]:size-3.5">
								{option.icon}
							</span>
						)}
						<span className="min-w-0 break-words text-start">{option.label}</span>
					</ChoiceButton>
				);
			})}
		</div>
	);
}
