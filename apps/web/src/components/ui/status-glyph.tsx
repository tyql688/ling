import { cn } from "@renderer/lib/utils";
import { STATUS_PRESENTATION, type StatusMeaning } from "./status-presentation";

export function StatusGlyph({ status, className }: { status: StatusMeaning; className?: string }) {
	const { icon: Icon, className: tone } = STATUS_PRESENTATION[status];
	return (
		<span
			aria-hidden="true"
			className={cn(
				"inline-flex shrink-0 items-center justify-center",
				tone,
				status === "active" && "ling-spin",
				className,
			)}
		>
			<Icon className="size-3.5" />
		</span>
	);
}
