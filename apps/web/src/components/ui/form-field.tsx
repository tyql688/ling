import { cn } from "@renderer/lib/utils";
import { cloneElement, useId, type AriaAttributes, type ComponentProps, type ReactElement } from "react";

/** A visible, clickable label for one input, textarea, or select trigger. */
export function FormField({
	label,
	description,
	children,
	className,
	...props
}: Omit<ComponentProps<"label">, "children"> & {
	label: string;
	description?: string;
	children: ReactElement<AriaAttributes>;
}) {
	const descriptionId = useId();
	return (
		<label {...props} className={cn("flex min-w-0 flex-col gap-1.5 text-ui text-text-secondary", className)}>
			<span>{label}</span>
			{description
				? cloneElement(children, {
						"aria-describedby": [children.props["aria-describedby"], descriptionId].filter(Boolean).join(" "),
					})
				: children}
			{description && (
				<span id={descriptionId} className="text-xs leading-relaxed text-text-muted">
					{description}
				</span>
			)}
		</label>
	);
}
