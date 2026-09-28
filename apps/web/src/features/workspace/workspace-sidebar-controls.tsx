import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { Activity } from "lucide-react";

export function MoreSessionsButton({ label, onClick }: { label: string; onClick: () => void }) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="flex h-7 w-full items-center rounded-control px-3 text-left text-xs tabular-nums text-text-muted transition-colors hover:bg-surface-hover hover:text-text-primary"
		>
			{label}
		</button>
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
