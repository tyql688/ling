import { noDragRegionClassName } from "@renderer/lib/platform";
import { cn } from "@renderer/lib/utils";
import type { ComponentPropsWithRef } from "react";

export const ICON_BUTTON_CLASS =
	"flex size-7 shrink-0 cursor-default items-center justify-center rounded-control text-text-muted transition-colors hover:bg-surface-hover hover:text-text-primary focus-visible:bg-surface-hover focus-visible:text-text-primary active:bg-surface-hover disabled:pointer-events-none disabled:opacity-40";

/** Compact workbench action; callers provide its accessible name. */
export function IconButton({ className, ...props }: ComponentPropsWithRef<"button">) {
	return <button type="button" {...props} className={cn(ICON_BUTTON_CLASS, noDragRegionClassName, className)} />;
}
