import "./menu.css";
import { cn } from "@renderer/lib/utils";

/** Shared surface and motion for dropdowns, context menus, and selects. */
export const menuContentClass = cn(
	"origin-(--menu-transform-origin) data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 motion-reduce:animate-none",
	"data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2",
	"glass-surface floating-surface z-50 rounded-menu border border-border-subtle bg-popover text-text-primary shadow-(--shadow-floating) outline-none duration-100",
);

const menuItemBaseClass = cn(
	"menu-item relative flex min-h-7 cursor-default select-none items-center gap-2 rounded-menu-item px-2 py-1 text-ui text-text-primary outline-none",
	"data-[variant=destructive]:text-danger",
	"[&_svg]:pointer-events-none [&_svg]:size-3.5 [&_svg]:shrink-0",
);

export const menuItemClass = cn(menuItemBaseClass, "data-[disabled]:pointer-events-none data-[disabled]:opacity-45");

/** Two-line choices retain the shared menu highlight, focus and corner geometry. */
export const pickerItemClass = cn(
	menuItemBaseClass,
	// cmdk renders data-disabled="false" for enabled items; Radix omits the attribute instead.
	"min-h-11 w-full gap-1.5 px-1.5 py-1.5 data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-45 data-[selected=true]:bg-surface-hover",
);
