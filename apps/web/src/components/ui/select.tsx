import * as SelectPrimitive from "@radix-ui/react-select";
import { cn } from "@renderer/lib/utils";
import { CheckIcon, ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import type { ReactNode, ComponentPropsWithRef } from "react";
import { useMenuMotion } from "./menu-motion";
import { menuContentClass, menuItemClass } from "./menu-styles";

/** Keep Radix controlled while callers use `null` for "nothing selected". */
function Select({
	value,
	...props
}: Omit<SelectPrimitive.SelectProps, "value"> & { value?: string | null | undefined }) {
	return <SelectPrimitive.Root {...props} value={value ?? ""} />;
}

function SelectTrigger({
	className,
	children,
	size = "default",
	variant = "default",
	...props
}: ComponentPropsWithRef<typeof SelectPrimitive.Trigger> & {
	size?: "default" | "sm" | "icon";
	variant?: "default" | "ghost";
}) {
	return (
		<SelectPrimitive.Trigger
			data-slot="select-trigger"
			className={cn(
				"flex h-9 w-fit items-center justify-between gap-1.5 whitespace-nowrap rounded-control border border-border-subtle aria-invalid:border-danger bg-input px-2.5 text-sm text-text-primary transition-colors",
				"hover:bg-surface-hover focus:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50",
				"outline-none focus-visible:outline-2 focus-visible:outline-border-strong focus-visible:-outline-offset-2",
				"data-[placeholder]:text-text-muted [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-text-muted",
				size === "sm" && "h-7 px-1.5 text-xs font-normal",
				variant === "ghost" && "w-auto border-transparent bg-transparent text-text-muted hover:text-text-primary",
				size === "icon" && "size-7 justify-center px-1 [&>svg:last-child]:hidden",
				className,
			)}
			{...props}
		>
			{children}
			<SelectPrimitive.Icon asChild>
				<ChevronDownIcon />
			</SelectPrimitive.Icon>
		</SelectPrimitive.Trigger>
	);
}

/** Render the selected label without relying on options that only mount inside the open popup. */
function SelectValue({ className, children }: { className?: string; children?: ReactNode | (() => ReactNode) }) {
	return (
		<span data-slot="select-value" className={cn("truncate", className)}>
			{typeof children === "function" ? children() : children}
		</span>
	);
}

function SelectContent({
	className,
	children,
	position = "popper",
	sideOffset = 4,
	align = "start",
	...props
}: SelectPrimitive.SelectContentProps) {
	const motionRef = useMenuMotion<HTMLDivElement>();
	return (
		<SelectPrimitive.Portal>
			<SelectPrimitive.Content
				ref={motionRef}
				data-slot="select-content"
				position={position}
				sideOffset={sideOffset}
				align={align}
				className={cn(
					menuContentClass,
					"[--menu-transform-origin:var(--radix-select-content-transform-origin)] min-w-[max(9rem,var(--radix-select-trigger-width))] max-w-(--radix-select-content-available-width) max-h-(--radix-select-content-available-height) overflow-hidden",
					className,
				)}
				{...props}
			>
				<SelectScrollUpButton />
				<SelectPrimitive.Viewport className="p-1">{children}</SelectPrimitive.Viewport>
				<SelectScrollDownButton />
			</SelectPrimitive.Content>
		</SelectPrimitive.Portal>
	);
}

function SelectItem({ className, children, ...props }: SelectPrimitive.SelectItemProps) {
	return (
		<SelectPrimitive.Item
			data-slot="select-item"
			className={cn(
				menuItemClass,
				"w-full pr-8 [&>span:first-child]:min-w-0 [&>span:first-child]:break-words",
				className,
			)}
			{...props}
		>
			<SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
			<SelectPrimitive.ItemIndicator
				data-slot="select-item-indicator"
				className="pointer-events-none absolute right-2 flex size-4 items-center justify-center"
			>
				<CheckIcon className="size-3.5" aria-hidden="true" />
			</SelectPrimitive.ItemIndicator>
		</SelectPrimitive.Item>
	);
}

function SelectScrollUpButton({ className, ...props }: SelectPrimitive.SelectScrollUpButtonProps) {
	return (
		<SelectPrimitive.ScrollUpButton
			data-slot="select-scroll-up-button"
			className={cn(
				"flex w-full cursor-default items-center justify-center bg-surface-raised py-1 text-text-muted [&_svg]:size-4",
				className,
			)}
			{...props}
		>
			<ChevronUpIcon aria-hidden="true" />
		</SelectPrimitive.ScrollUpButton>
	);
}

function SelectScrollDownButton({ className, ...props }: SelectPrimitive.SelectScrollDownButtonProps) {
	return (
		<SelectPrimitive.ScrollDownButton
			data-slot="select-scroll-down-button"
			className={cn(
				"flex w-full cursor-default items-center justify-center bg-surface-raised py-1 text-text-muted [&_svg]:size-4",
				className,
			)}
			{...props}
		>
			<ChevronDownIcon aria-hidden="true" />
		</SelectPrimitive.ScrollDownButton>
	);
}

export { Select, SelectContent, SelectItem, SelectTrigger, SelectValue };
