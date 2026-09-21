import piBrush from "@renderer/assets/pi-brush.png";
import { cn } from "@renderer/lib/utils";

const GLYPH_WIDTH = {
	xs: "0.75rem",
	sm: "1.75rem",
	md: "6rem",
	lg: "min(220px, 40vw)",
} as const;

interface LoadingTransitionProps {
	label: string;
	size?: keyof typeof GLYPH_WIDTH;
	className?: string;
}

export function LoadingTransition({ label, size = "md", className }: LoadingTransitionProps) {
	return (
		<div
			className={cn("view-fade-in flex min-h-48 w-full items-center justify-center", className)}
			role="status"
			aria-live="polite"
			aria-busy="true"
		>
			<div
				aria-hidden="true"
				className="empty-state-glyph loading-transition-glyph shrink-0"
				style={{
					width: GLYPH_WIDTH[size],
					maskImage: `url(${piBrush})`,
					WebkitMaskImage: `url(${piBrush})`,
				}}
			/>
			<span className="sr-only">{label}</span>
		</div>
	);
}
