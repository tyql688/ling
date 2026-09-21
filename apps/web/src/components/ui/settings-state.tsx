import { Button } from "@renderer/components/ui/button";
import { cn } from "@renderer/lib/utils";
import { Info, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

interface SettingsStateProps {
	icon?: LucideIcon;
	title: string;
	description?: ReactNode;
	action?: ReactNode;
	tone?: "neutral" | "danger";
	compact?: boolean;
	className?: string;
}

/** Full-page and in-list states intentionally use the same hierarchy. */
export function SettingsState({
	icon: StateIcon = Info,
	title,
	description,
	action,
	tone = "neutral",
	compact = false,
	className,
}: SettingsStateProps) {
	return (
		<div
			role={tone === "danger" ? "alert" : undefined}
			className={cn(
				"flex min-w-0 flex-col items-center justify-center rounded-panel border border-dashed border-border-subtle px-5 text-center",
				compact ? "min-h-28 py-5" : "min-h-48 py-8",
				tone === "danger" && "border-danger/30 bg-danger/5",
				className,
			)}
		>
			<div
				className={cn(
					"mb-3 flex size-9 items-center justify-center rounded-control bg-surface-hover text-text-muted",
					tone === "danger" && "bg-danger/10 text-danger",
				)}
			>
				<StateIcon className="size-4" aria-hidden="true" />
			</div>
			<p className={cn("text-sm font-medium text-text-primary", tone === "danger" && "text-danger")}>{title}</p>
			{description && <p className="mt-1 max-w-lg text-xs leading-relaxed text-text-muted">{description}</p>}
			{action && <div className="mt-4 flex flex-wrap items-center justify-center gap-2">{action}</div>}
		</div>
	);
}

interface SettingsRetryActionProps {
	label: string;
	onClick: () => void;
	disabled?: boolean;
}

export function SettingsRetryAction({ label, onClick, disabled = false }: SettingsRetryActionProps) {
	return (
		<Button variant="outline" size="sm" disabled={disabled} onClick={onClick}>
			{label}
		</Button>
	);
}
