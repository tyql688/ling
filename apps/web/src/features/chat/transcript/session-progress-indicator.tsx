import { cn } from "@renderer/lib/utils";

/** Animates three HTML dots with transform and opacity on the compositor thread. Chromium transforms on SVG children require main-thread and layerization work each frame, measured at ~24-32% of a core during a run. */
export function SessionProgressIndicator({ className }: { className?: string }) {
	return (
		<span className={cn("ling-session-progress shrink-0 text-accent", className)} aria-hidden="true">
			<span className="ling-session-progress-dot" />
			<span className="ling-session-progress-dot" />
			<span className="ling-session-progress-dot" />
		</span>
	);
}
