import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { Activity, ChevronDown } from "lucide-react";

export function MoreSessionsButton({ count, label, onClick }: { count: number; label: string; onClick: () => void }) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<button
						type="button"
						onClick={onClick}
						aria-label={label}
						className="mt-0.5 flex h-7 w-full items-center justify-center gap-1 rounded-control text-xs tabular-nums text-text-muted transition-colors hover:bg-surface-hover hover:text-text-primary"
					/>
				}
			>
				<ChevronDown className="size-3.5" aria-hidden="true" />
				<span>+{count}</span>
			</TooltipTrigger>
			<TooltipContent>{label}</TooltipContent>
		</Tooltip>
	);
}

export function ProjectActivityCount({ count, label }: { count: number; label: string }) {
	if (count === 0) return null;
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<span
						role="status"
						aria-label={label}
						className="inline-flex h-6 shrink-0 items-center gap-1 text-xs tabular-nums text-text-muted"
					/>
				}
			>
				<Activity className="size-3" aria-hidden="true" />
				{count}
			</TooltipTrigger>
			<TooltipContent>{label}</TooltipContent>
		</Tooltip>
	);
}
