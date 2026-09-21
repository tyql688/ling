import { cn } from "@renderer/lib/utils";
import type { ComponentProps } from "react";

/** Workbench panels retain usable padding and heading sizes inside a narrow sidebar. */
export function PanelPage({ title, children, className, ...props }: ComponentProps<"section"> & { title: string }) {
	return (
		<section
			{...props}
			className={cn("flex h-full min-w-0 flex-col gap-4 overflow-y-auto p-4 text-sm text-text-primary", className)}
		>
			<h1 className="text-base font-semibold tracking-tight">{title}</h1>
			{children}
		</section>
	);
}
