import { cn } from "@renderer/lib/utils";
import { AnimatePresence, motion } from "motion/react";
import type { ReactNode } from "react";

/** Vertical expand/collapse presence for banners and inline notices. */
export function VerticalReveal({
	show,
	children,
	className,
}: {
	show: boolean;
	children: ReactNode;
	className?: string;
}) {
	return (
		<AnimatePresence initial={false}>
			{show && (
				<motion.div
					initial={{ height: 0, opacity: 0 }}
					animate={{ height: "auto", opacity: 1 }}
					exit={{ height: 0, opacity: 0 }}
					transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
					className={cn("shrink-0 overflow-hidden", className)}
				>
					{children}
				</motion.div>
			)}
		</AnimatePresence>
	);
}
