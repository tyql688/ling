import { useId, type ComponentProps, type ReactNode } from "react";
import { Check } from "lucide-react";
import { cn } from "@renderer/lib/utils";

/** A full-width native radio or checkbox, with the same surface and focus tokens as Ling forms. */
export function ChoiceRow({
	multiple = false,
	children,
	description,
	className,
	...props
}: Omit<ComponentProps<"input">, "type" | "size" | "children" | "defaultChecked"> & {
	checked: boolean;
	multiple?: boolean;
	children: ReactNode;
	description?: ReactNode;
}) {
	const labelId = useId();
	const descriptionId = useId();
	return (
		<label
			className={cn(
				"relative flex min-h-11 min-w-0 items-start gap-3 rounded-control border px-3 py-2.5 text-start text-ui text-text-primary transition-colors motion-reduce:transition-none",
				"has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-inset has-[:focus-visible]:ring-border-strong",
				props.checked ? "border-border-strong bg-surface-raised" : "border-border-subtle bg-surface",
				props.disabled ? "opacity-45" : "hover:border-border-strong hover:bg-surface-raised",
				className,
			)}
		>
			<input
				{...props}
				type={multiple ? "checkbox" : "radio"}
				aria-labelledby={labelId}
				aria-describedby={description ? descriptionId : undefined}
				className="absolute inset-0 m-0 size-full cursor-pointer opacity-0 disabled:cursor-default"
			/>
			<span
				aria-hidden="true"
				className={cn(
					"pointer-events-none mt-0.5 flex size-4 shrink-0 items-center justify-center border",
					multiple ? "rounded-[4px]" : "rounded-full",
					props.checked
						? "border-transparent bg-choice-selected text-choice-selected-foreground"
						: "border-text-muted bg-surface",
				)}
			>
				{props.checked &&
					(multiple ? (
						<Check className="size-3" strokeWidth={2.5} />
					) : (
						<span className="size-1.5 rounded-full bg-current" />
					))}
			</span>
			<span className="pointer-events-none min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere]">
				<span id={labelId} className="block font-medium leading-5">
					{children}
				</span>
				{description && (
					<span id={descriptionId} className="mt-0.5 block text-xs leading-relaxed text-text-muted">
						{description}
					</span>
				)}
			</span>
		</label>
	);
}
