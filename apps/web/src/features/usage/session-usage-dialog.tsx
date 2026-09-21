import { formatCompactNumber } from "@renderer/lib/format-number";
import type { SessionMessage } from "@ling/contracts/session";
import {
	Dialog,
	DialogCloseButton,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "@renderer/components/ui/dialog";
import { LoadingTransition } from "@renderer/components/ui/loading-transition";
import { formatCost } from "@renderer/lib/format";

import { cn } from "@renderer/lib/utils";
import { ChartColumn, PieChart } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { SessionModelBreakdown, SessionToolBreakdown } from "./session-tool-model-charts";
import { SessionTokenMix, SessionTokenTimeline } from "./session-usage-charts";
import "./session-usage.css";
import { analyzeSessionUsage, type ContextUsage } from "./workspace-session-usage";

function ContextPanel({ contextUsage }: { contextUsage: ContextUsage | null }) {
	const { t } = useTranslation();
	return (
		<section className="rounded-panel border border-border-subtle bg-surface-raised px-3.5 py-3">
			<div className="flex items-start justify-between gap-4">
				<div>
					<h3 className="text-sm font-semibold text-text-primary">{t("session.context")}</h3>
					{!contextUsage && <p className="mt-1 text-xs text-text-muted">{t("session.usageContextUnavailable")}</p>}
				</div>
				<span
					className={cn(
						"font-mono text-xl font-semibold tabular-nums",
						!contextUsage
							? "text-text-muted"
							: contextUsage.percent >= 90
								? "text-context-high"
								: contextUsage.percent >= 70
									? "text-context-medium"
									: "text-text-primary",
					)}
				>
					{contextUsage ? `${contextUsage.percent}%` : "—"}
				</span>
			</div>
			<div
				className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface"
				{...(contextUsage
					? {
							role: "progressbar",
							"aria-label": t("session.context"),
							"aria-valuemin": 0,
							"aria-valuemax": 100,
							"aria-valuenow": contextUsage.percent,
						}
					: {})}
			>
				{contextUsage && (
					<div
						className={cn(
							"h-full rounded-full",
							contextUsage.percent >= 90
								? "bg-context-high"
								: contextUsage.percent >= 70
									? "bg-context-medium"
									: "bg-text-primary/70",
						)}
						style={{ width: `${contextUsage.percent}%` }}
					/>
				)}
			</div>
			<dl className="mt-2.5 flex items-center justify-between gap-4 text-xs">
				<div className="flex items-baseline gap-1.5">
					<dt className="text-text-muted">{t("session.usageContextUsed")}</dt>
					<dd className="font-mono tabular-nums text-text-primary">{contextUsage?.used ?? "—"}</dd>
				</div>
				<div className="flex items-baseline gap-1.5">
					<dt className="text-text-muted">{t("session.usageContextWindow")}</dt>
					<dd className="font-mono tabular-nums text-text-primary">{contextUsage?.total ?? "—"}</dd>
				</div>
			</dl>
		</section>
	);
}

interface SessionUsageDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	messages: readonly SessionMessage[];
	contextUsage: ContextUsage | null;
	ready: boolean;
}

const EMPTY_ANALYSIS = analyzeSessionUsage([]);

export function SessionUsageDialog({ open, onOpenChange, messages, contextUsage, ready }: SessionUsageDialogProps) {
	const { t, i18n } = useTranslation();
	const language = i18n.resolvedLanguage ?? i18n.language;
	// Stats computation and chart mounting are deferred until the opening animation starts, avoiding main-thread contention with the zoom frame.
	const [settled, setSettled] = useState(false);
	useEffect(() => {
		if (!open) {
			// Unmount content only after the exit animation finishes, otherwise the panel flips back to the loading state before it shrinks.
			const timer = setTimeout(() => setSettled(false), 200);
			return () => clearTimeout(timer);
		}
		let second = 0;
		const first = requestAnimationFrame(() => {
			second = requestAnimationFrame(() => setSettled(true));
		});
		// rAF does not fire while the window is occluded/backgrounded — a timeout covers that case.
		const fallback = window.setTimeout(() => setSettled(true), 120);
		return () => {
			cancelAnimationFrame(first);
			cancelAnimationFrame(second);
			window.clearTimeout(fallback);
		};
	}, [open]);
	const analysis = useMemo(
		() => (settled && ready ? analyzeSessionUsage(messages) : EMPTY_ANALYSIS),
		[messages, settled, ready],
	);
	const { summary } = analysis;
	const toolCalls = analysis.tools.reduce((total, tool) => total + tool.calls, 0);
	const toolFailures = analysis.tools.reduce((total, tool) => total + tool.failures, 0);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				id="session-usage-dialog"
				size="large"
				overlayClassName="session-usage-overlay"
				className="session-usage-dialog flex max-h-[min(54rem,calc(100dvh-2rem))] max-w-5xl flex-col overflow-hidden p-0"
			>
				<header className="shrink-0 border-border-subtle border-b px-4 py-3 pr-12">
					<DialogTitle className="flex items-center gap-2">
						<span className="grid size-7 place-items-center rounded-control bg-surface-hover">
							<ChartColumn className="size-3.5 text-text-muted" aria-hidden="true" />
						</span>
						{t("session.usageTitle")}
					</DialogTitle>
					<DialogDescription className="sr-only">{t("session.usageDescription")}</DialogDescription>
				</header>
				<DialogCloseButton aria-label={t("session.usageClose")} />

				{ready && settled ? (
					<div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 [scrollbar-gutter:stable]">
						<ContextPanel contextUsage={contextUsage} />

						<section className="rounded-panel border border-border-subtle bg-surface-raised p-4">
							<div className="flex items-end justify-between gap-4">
								<div>
									<h3 className="text-sm font-semibold text-text-primary">{t("session.usageTokens")}</h3>
									<div className="mt-1 text-xs text-text-muted">
										{t("session.usageResponsesCompact", { count: summary.turns })}
									</div>
								</div>
								<div className="shrink-0 text-right">
									<div className="font-mono text-xl font-semibold tabular-nums text-text-primary">
										{formatCompactNumber(summary.totalTokens, language)}
									</div>
									<div className="mt-0.5 font-mono text-xs tabular-nums text-text-muted">
										{formatCost(summary.costTotal)}
									</div>
								</div>
							</div>
							<div className="mt-3.5">
								<SessionTokenMix summary={summary} />
							</div>
							<div className="mt-4 border-border-subtle border-t pt-3.5">
								<SessionTokenTimeline events={analysis.events} />
							</div>
							<div className="mt-4 border-border-subtle border-t pt-3.5">
								<h4 className="text-xs font-semibold text-text-primary">{t("session.usageModels")}</h4>
								<div className="mt-3">
									<SessionModelBreakdown models={analysis.models} totalTokens={summary.totalTokens} />
								</div>
								{analysis.unattributedTokens > 0 && (
									<div className="mt-2 text-xs text-text-muted">
										{t("session.usageUnattributedModel", {
											amount: formatCompactNumber(analysis.unattributedTokens, language),
										})}
									</div>
								)}
							</div>
						</section>

						<section className="rounded-panel border border-border-subtle bg-surface-raised p-4">
							<div className="flex items-start justify-between gap-3">
								<div>
									<h3 className="text-sm font-semibold text-text-primary">{t("session.usageTools")}</h3>
									<div className="mt-1 text-xs text-text-muted">
										{t("session.usageToolsCompact", { calls: toolCalls, failures: toolFailures })}
									</div>
								</div>
								<PieChart className="mt-0.5 size-4 shrink-0 text-text-muted" aria-hidden="true" />
							</div>
							<div className="mt-3">
								<SessionToolBreakdown tools={analysis.tools} />
							</div>
						</section>

						{summary.compactions > 0 && (
							<div className="px-1 text-xs text-text-muted">
								{t("session.usageCompactions")}: {summary.compactions.toLocaleString(language)}
							</div>
						)}
					</div>
				) : (
					<div className="grid min-h-80 place-items-center">
						<LoadingTransition label={t("session.usageLoading")} />
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}
