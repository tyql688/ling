import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { cn } from "@renderer/lib/utils";
import { cloneElement, type ReactElement, type ReactNode } from "react";
import { menuContentClass, menuItemClass } from "./menu-styles";

function DropdownMenu(props: DropdownMenuPrimitive.DropdownMenuProps) {
	return <DropdownMenuPrimitive.Root {...props} />;
}

/** base-ui-era `render={<button/>}` call sites map onto radix `asChild`. */
function DropdownMenuTrigger({
	render,
	children,
}: {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- accepts any host element to merge children into
	render?: ReactElement<any>;
	children?: ReactNode;
}) {
	return (
		<DropdownMenuPrimitive.Trigger asChild>
			{render ? children === undefined ? render : cloneElement(render, undefined, children) : <span>{children}</span>}
		</DropdownMenuPrimitive.Trigger>
	);
}

function DropdownMenuContent({
	className,
	sideOffset = 4,
	align = "start",
	...props
}: DropdownMenuPrimitive.DropdownMenuContentProps) {
	return (
		<DropdownMenuPrimitive.Portal>
			<DropdownMenuPrimitive.Content
				data-slot="dropdown-menu-content"
				sideOffset={sideOffset}
				align={align}
				className={cn(
					menuContentClass,
					"[--menu-transform-origin:var(--radix-dropdown-menu-content-transform-origin)] min-w-36 max-h-(--radix-dropdown-menu-content-available-height) overflow-y-auto p-1",
					className,
				)}
				{...props}
			/>
		</DropdownMenuPrimitive.Portal>
	);
}

interface DropdownMenuItemProps extends DropdownMenuPrimitive.DropdownMenuItemProps {
	variant?: "default" | "destructive";
}

function DropdownMenuItem({ className, variant = "default", ...props }: DropdownMenuItemProps) {
	return (
		<DropdownMenuPrimitive.Item
			data-slot="dropdown-menu-item"
			data-variant={variant}
			className={cn(menuItemClass, className)}
			{...props}
		/>
	);
}

function DropdownMenuLabel({ className, ...props }: DropdownMenuPrimitive.DropdownMenuLabelProps) {
	return (
		<DropdownMenuPrimitive.Label
			data-slot="dropdown-menu-label"
			className={cn("px-2 py-1 text-xs font-medium text-text-muted", className)}
			{...props}
		/>
	);
}

function DropdownMenuSeparator({ className, ...props }: DropdownMenuPrimitive.DropdownMenuSeparatorProps) {
	return (
		<DropdownMenuPrimitive.Separator
			data-slot="dropdown-menu-separator"
			className={cn("mx-2 my-1 h-px bg-border-subtle", className)}
			{...props}
		/>
	);
}

export {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
};
