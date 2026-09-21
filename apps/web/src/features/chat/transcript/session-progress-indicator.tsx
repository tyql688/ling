import { cn } from "@renderer/lib/utils";

/**
 * A quiet three-dot hop keeps the working state friendly without competing with the status text.
 * Plain elements rather than SVG circles: Chromium cannot composite a transform on an SVG child,
 * so the same keyframes there forced a main-frame plus a full layerize pass on every vsync for as
 * long as a run was in flight (measured ~24-32% of a core). On HTML elements transform/opacity
 * animate on the compositor thread instead.
 */
export function SessionProgressIndicator({ className }: { className?: string }) {
	return (
		<span className={cn("ling-session-progress shrink-0 text-accent", className)} aria-hidden="true">
			<span className="ling-session-progress-dot" />
			<span className="ling-session-progress-dot" />
			<span className="ling-session-progress-dot" />
		</span>
	);
}
