import { cn } from "@renderer/lib/utils";
import type { ReactNode } from "react";

interface SettingsPageProps {
	title: string;
	description?: string;
	actions?: ReactNode;
	/** Pages whose content scrolls internally (e.g. the two-pane models page) pass false. */
	scrollable?: boolean;
	children: ReactNode;
}

/** Shared scaffold for every settings category. */
export function SettingsPage({ title, description, actions, scrollable = true, children }: SettingsPageProps) {
	return (
		<div className={cn("flex h-full flex-col", scrollable && "overflow-y-auto")}>
			<div
				className={cn(
					"mx-auto flex w-full max-w-4xl flex-col gap-8 px-4 pb-6 pt-6 sm:px-8 sm:pb-9 sm:pt-9 md:pt-[max(2.25rem,var(--window-controls-height))] lg:gap-10 lg:px-10 lg:pb-11 lg:pt-[max(2.75rem,var(--window-controls-height))]",
					!scrollable && "min-h-0 flex-1",
				)}
			>
				<header className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
					<div className="flex flex-col gap-1.5">
						<h1 className="text-xl font-semibold tracking-[-0.025em] text-text-primary sm:text-xl">{title}</h1>
						{description && <p className="max-w-2xl text-sm leading-relaxed text-text-muted">{description}</p>}
					</div>
					{actions && <div className="flex flex-wrap items-center gap-2 sm:shrink-0">{actions}</div>}
				</header>
				{children}
			</div>
		</div>
	);
}
