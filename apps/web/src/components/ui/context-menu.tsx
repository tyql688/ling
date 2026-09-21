import * as ContextMenuPrimitive from "@radix-ui/react-context-menu";
import { useMenuMotion } from "@renderer/components/ui/menu-motion";
import { menuContentClass, menuItemClass } from "@renderer/components/ui/menu-styles";
import { cn } from "@renderer/lib/utils";

function ContextMenu(props: ContextMenuPrimitive.ContextMenuProps) {
	return <ContextMenuPrimitive.Root {...props} />;
}

function ContextMenuTrigger(props: ContextMenuPrimitive.ContextMenuTriggerProps) {
	return <ContextMenuPrimitive.Trigger {...props} />;
}

function ContextMenuContent({ className, ...props }: ContextMenuPrimitive.ContextMenuContentProps) {
	const motionRef = useMenuMotion<HTMLDivElement>();
	return (
		<ContextMenuPrimitive.Portal>
			<ContextMenuPrimitive.Content
				ref={motionRef}
				data-slot="context-menu-content"
				className={cn(
					menuContentClass,
					"[--menu-transform-origin:var(--radix-context-menu-content-transform-origin)] min-w-36 max-h-(--radix-context-menu-content-available-height) overflow-y-auto p-1",
					className,
				)}
				{...props}
			/>
		</ContextMenuPrimitive.Portal>
	);
}

interface ContextMenuItemProps extends ContextMenuPrimitive.ContextMenuItemProps {
	variant?: "default" | "destructive";
}

function ContextMenuItem({ className, variant = "default", ...props }: ContextMenuItemProps) {
	return (
		<ContextMenuPrimitive.Item
			data-slot="context-menu-item"
			data-variant={variant}
			className={cn(menuItemClass, className)}
			{...props}
		/>
	);
}

function ContextMenuSeparator({ className, ...props }: ContextMenuPrimitive.ContextMenuSeparatorProps) {
	return (
		<ContextMenuPrimitive.Separator
			data-slot="context-menu-separator"
			className={cn("-mx-1 my-1 h-px bg-border-subtle", className)}
			{...props}
		/>
	);
}

export { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger };
