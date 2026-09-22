import {
	AppFeedbackContext,
	type AppFeedbackContextValue,
	type AppFeedbackInput,
	type FeedbackTone,
} from "@renderer/lib/feedback-context";
import { cn } from "@renderer/lib/utils";
import { type LucideIcon, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { STATUS_PRESENTATION } from "./status-presentation";

/** Feedback tone → icon/surface color/ARIA role; info/success use status, warning/danger use alert. */
const FEEDBACK_STYLE: Record<
	FeedbackTone,
	{ icon: LucideIcon; surface: string; iconClassName: string; role: "alert" | "status" }
> = {
	info: { ...STATUS_PRESENTATION.neutral, iconClassName: STATUS_PRESENTATION.neutral.className, role: "status" },
	success: { ...STATUS_PRESENTATION.success, iconClassName: STATUS_PRESENTATION.success.className, role: "status" },
	warning: { ...STATUS_PRESENTATION.attention, iconClassName: STATUS_PRESENTATION.attention.className, role: "alert" },
	danger: { ...STATUS_PRESENTATION.error, iconClassName: STATUS_PRESENTATION.error.className, role: "alert" },
};

interface FeedbackNoticeProps {
	id?: string;
	tone?: FeedbackTone;
	title?: string;
	children?: ReactNode;
	action?: ReactNode;
	className?: string;
}

/** Contextual feedback that remains in the owning page, dialog, or panel. */
export function FeedbackNotice({ id, tone = "info", title, children, action, className }: FeedbackNoticeProps) {
	const style = FEEDBACK_STYLE[tone];
	const Icon = style.icon;
	return (
		<div
			id={id}
			role={style.role}
			className={cn(
				"flex flex-col gap-3 rounded-panel border px-3.5 py-3 text-sm sm:flex-row sm:items-start",
				style.surface,
				className,
			)}
		>
			<Icon className={cn("mt-0.5 size-4 shrink-0", style.iconClassName)} aria-hidden="true" />
			<div className="min-w-0 flex-1">
				{title && <p className="font-medium text-current">{title}</p>}
				{children !== null && children !== undefined && (
					<div className={cn("leading-relaxed", title && "mt-0.5")}>{children}</div>
				)}
			</div>
			{action && <div className="flex shrink-0 flex-wrap items-center gap-2">{action}</div>}
		</div>
	);
}

interface AppFeedbackEntry extends AppFeedbackInput {
	id: string;
}

/** Default auto-dismiss duration for success/info toasts; warning/danger require manual close. */
const TRANSIENT_FEEDBACK_DURATION_MS = 3_000;
function defaultDuration(tone: FeedbackTone): number | null {
	return tone === "success" || tone === "info" ? TRANSIENT_FEEDBACK_DURATION_MS : null;
}

export function AppFeedbackProvider({ children }: { children: ReactNode }) {
	const { t } = useTranslation();
	const [entries, setEntries] = useState<AppFeedbackEntry[]>([]);
	const nextIdRef = useRef(0);
	const dismiss = useCallback((id: string) => {
		setEntries((current) => current.filter((entry) => entry.id !== id));
	}, []);

	const show = useCallback((input: AppFeedbackInput): string => {
		nextIdRef.current += 1;
		const id = `feedback-${nextIdRef.current}`;
		const entry: AppFeedbackEntry = { ...input, id };
		// Publish and deduplicate together, including notices raised by child effects.
		setEntries((current) => [
			...current.filter((previous) => input.dedupeKey === undefined || previous.dedupeKey !== input.dedupeKey),
			entry,
		]);
		return id;
	}, []);

	const value = useMemo<AppFeedbackContextValue>(() => ({ show, dismiss }), [dismiss, show]);

	return (
		<AppFeedbackContext.Provider value={value}>
			{children}
			<section
				className="pointer-events-none fixed right-4 bottom-4 z-[70] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2"
				aria-label={t("feedback.region")}
			>
				<AnimatePresence initial={false}>
					{entries.map((entry) => (
						<FeedbackToast key={entry.id} entry={entry} dismiss={dismiss} />
					))}
				</AnimatePresence>
			</section>
		</AppFeedbackContext.Provider>
	);
}

function FeedbackToast({ entry, dismiss }: { entry: AppFeedbackEntry; dismiss: (id: string) => void }) {
	const { t } = useTranslation();
	const durationMs = entry.durationMs === undefined ? defaultDuration(entry.tone) : entry.durationMs;
	useEffect(() => {
		if (durationMs === null) return;
		const timer = window.setTimeout(() => dismiss(entry.id), durationMs);
		return () => window.clearTimeout(timer);
	}, [dismiss, entry.id, durationMs]);
	return (
		<motion.div
			layout
			initial={{ opacity: 0, y: 12, scale: 0.97 }}
			animate={{ opacity: 1, y: 0, scale: 1 }}
			exit={{ opacity: 0, scale: 0.95 }}
			transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
		>
			<FeedbackNotice
				tone={entry.tone}
				title={entry.title}
				action={
					<button
						type="button"
						className="pointer-events-auto -m-1 flex size-7 items-center justify-center rounded-control text-current/70 transition-colors hover:bg-surface-hover hover:text-current focus-visible:bg-surface-hover focus-visible:text-current"
						aria-label={t("feedback.dismiss")}
						onClick={() => dismiss(entry.id)}
					>
						<X className="size-3.5" aria-hidden="true" />
					</button>
				}
				className="glass-surface floating-surface pointer-events-auto bg-dialog shadow-(--shadow-floating)"
			>
				{entry.description}
			</FeedbackNotice>
		</motion.div>
	);
}
