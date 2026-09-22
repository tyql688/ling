import { FeedbackNotice } from "@renderer/components/ui/feedback";
import { cn } from "@renderer/lib/utils";
import { Paperclip } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

/** The input owns its focus edge and protected scene material in both entry points. */
const COMPOSER_FRAME_CLASSNAME =
	"scene-surface composer-surface @container/composer relative flex w-full flex-col gap-3 rounded-panel border border-border-subtle bg-composer p-3";

/** Full-card overlay shown while files or images are dragged in. */
function ComposerDropOverlay({ active }: { active: boolean }) {
	const { t } = useTranslation();
	return (
		<AnimatePresence>
			{active && (
				<motion.div
					initial={{ opacity: 0, scale: 0.98 }}
					animate={{ opacity: 1, scale: 1 }}
					exit={{ opacity: 0, scale: 0.98 }}
					transition={{ duration: 0.15, ease: [0.22, 1, 0.36, 1] }}
					className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-[inherit] border-2 border-dashed border-text-muted/45 bg-composer"
				>
					<span className="flex items-center gap-2 text-sm font-medium text-accent">
						<Paperclip className="size-4" aria-hidden="true" />
						{t("session.dropAttachmentsHint")}
					</span>
				</motion.div>
			)}
		</AnimatePresence>
	);
}

/** Inline error/warning inside the input area: unified FeedbackNotice, replacing scattered text-danger paragraphs. */
export function ComposerInlineAlert({
	id,
	message,
	tone = "danger",
	className,
}: {
	id?: string | undefined;
	message: string | null;
	tone?: "danger" | "warning" | "info";
	className?: string | undefined;
}) {
	if (message === null || message.length === 0) return null;
	return (
		<FeedbackNotice
			{...(id === undefined ? {} : { id })}
			tone={tone}
			className={cn("rounded-control px-3 py-2 text-xs", className)}
		>
			{message}
		</FeedbackNotice>
	);
}

/** Optional shell: card + drop overlay + child content. */
export function ComposerCard({
	variant,
	dropActive,
	dropHandlers,
	className,
	children,
}: {
	variant: "session" | "home";
	dropActive: boolean;
	dropHandlers?: Record<string, unknown> | undefined;
	className?: string | undefined;
	children: ReactNode;
}) {
	return (
		<div
			data-composer-card=""
			data-session-composer={variant === "session" ? true : undefined}
			{...(dropHandlers ?? {})}
			// The completion popover must escape the frame; never clip the card's overflow.
			className={cn(COMPOSER_FRAME_CLASSNAME, variant === "home" && "max-w-(--reading-measure) shrink-0", className)}
		>
			{variant === "session" && <span className="composer-working-edge" aria-hidden="true" />}
			<ComposerDropOverlay active={dropActive} />
			{children}
		</div>
	);
}
