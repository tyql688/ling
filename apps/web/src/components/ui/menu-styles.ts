import "./menu.css";
import { cn } from "@renderer/lib/utils";

/** Shared surface and motion for dropdowns, context menus, and selects. */
export const menuContentClass = cn(
	"origin-(--menu-transform-origin) data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 motion-reduce:animate-none",
	"data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2",
	"glass-surface z-50 rounded-control border border-border-subtle bg-popover shadow-floating outline-none duration-100",
);

export const menuItemClass = cn(
	"relative flex cursor-default select-none items-center gap-2 rounded-control px-2 py-1.5 text-sm text-text-primary outline-none",
	"focus:bg-surface-hover data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
	"data-[variant=destructive]:text-danger data-[variant=destructive]:focus:bg-danger/10",
	"[&_svg]:pointer-events-none [&_svg]:size-3.5 [&_svg]:shrink-0",
);
