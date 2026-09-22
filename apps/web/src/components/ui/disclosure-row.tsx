import { useReducedMotion } from "@renderer/hooks/use-reduced-motion";
import { cn } from "@renderer/lib/utils";
import { ChevronRight } from "lucide-react";
import { motion, MotionConfigContext } from "motion/react";
import { type ReactNode, useContext, useId, useState } from "react";

/** A compact inspector row. Details mount on first expansion and retain their interaction state. */
export function DisclosureRow({
	title,
	icon,
	description,
	summary,
	children,
	defaultOpen = false,
	className,
}: {
	title: ReactNode;
	icon: ReactNode;
	description?: ReactNode;
	summary?: ReactNode;
	children: ReactNode;
	defaultOpen?: boolean;
	className?: string;
}) {
	const id = useId();
	const systemReducedMotion = useReducedMotion();
	const motionConfig = useContext(MotionConfigContext);
	const reducedMotion = systemReducedMotion || motionConfig.reducedMotion === "always";
	const [{ open, mounted }, setState] = useState({ open: defaultOpen, mounted: defaultOpen });
	return (
		<section className={cn("min-w-0", className)}>
			<button
				type="button"
				aria-expanded={open}
				aria-controls={`${id}-details`}
				onClick={() => setState({ open: !open, mounted: true })}
				className="flex min-h-11 w-full items-center gap-2.5 px-4 py-2.5 text-left outline-none transition-colors hover:bg-surface-hover focus-visible:bg-surface-hover motion-reduce:transition-none"
			>
				<span className="shrink-0 text-text-muted [&>svg]:size-4" aria-hidden="true">
					{icon}
				</span>
				<span className="min-w-0 flex-1">
					<span
						className="block truncate text-sm font-medium text-text-primary"
						title={typeof title === "string" ? title : undefined}
					>
						{title}
					</span>
					{description && <span className="mt-0.5 block text-xs leading-relaxed text-text-muted">{description}</span>}
				</span>
				{summary !== undefined && summary !== null && (
					<span className="max-w-[45%] shrink-0 text-right text-xs tabular-nums text-text-muted">{summary}</span>
				)}
				<ChevronRight
					className={cn(
						"size-3.5 shrink-0 text-text-muted transition-transform duration-150 motion-reduce:transition-none",
						open && "rotate-90",
					)}
					aria-hidden="true"
				/>
			</button>
			{/* Retain inline geometry for responsive charts while excluding collapsed details from focus and accessibility. */}
			<div
				id={`${id}-details`}
				aria-hidden={!open}
				inert={!open}
				className={cn(!open && "invisible h-0 overflow-hidden")}
			>
				{mounted && (
					<motion.div
						initial={reducedMotion ? false : { opacity: 0, y: -3 }}
						animate={{ opacity: open ? 1 : 0, y: open || reducedMotion ? 0 : -3 }}
						transition={{ duration: reducedMotion ? 0 : 0.15 }}
						className="px-4 pt-1 pb-4"
					>
						{children}
					</motion.div>
				)}
			</div>
		</section>
	);
}
