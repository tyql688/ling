import { Circle, CircleAlert, CircleCheck, CircleDashed, Clock3 } from "lucide-react";

/** Domain owners choose meaning; surfaces share color, glyph and emphasis. */
export const STATUS_PRESENTATION = {
	success: {
		fill: "bg-success",
		className: "text-success",
		surface: "border-success/30 bg-success/5 text-success",
		icon: CircleCheck,
	},
	active: {
		className: "text-text-primary",
		surface: "border-border-subtle bg-surface-hover text-text-primary",
		icon: CircleDashed,
	},
	attention: {
		fill: "bg-warning",
		className: "text-warning",
		surface: "border-warning/30 bg-warning/5 text-warning",
		icon: Clock3,
	},
	error: {
		fill: "bg-danger",
		className: "text-danger",
		surface: "border-danger/30 bg-danger/5 text-danger",
		icon: CircleAlert,
	},
	neutral: {
		className: "text-text-muted",
		surface: "border-border-subtle bg-surface-raised/50 text-text-muted",
		icon: Circle,
	},
} as const;
export type StatusMeaning = keyof typeof STATUS_PRESENTATION;
