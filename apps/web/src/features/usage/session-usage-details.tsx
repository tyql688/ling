import type { SessionMessage } from "@ling/contracts/session-messages";
import { DisclosureRow } from "@renderer/components/ui/disclosure-row";
import { formatCost } from "@renderer/lib/format";
import { formatCompactNumber } from "@renderer/lib/format-number";
import { cn } from "@renderer/lib/utils";
import { Cpu, Layers, MessageSquare, PieChart, TrendingUp, Wrench } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { SessionModelBreakdown, SessionToolBreakdown } from "./session-tool-model-charts";
import { SessionTokenMix, SessionTokenTimeline } from "./session-usage-charts";
import { analyzeSessionUsage, type ContextUsage } from "./workspace-session-usage";

function ContextPanel({ contextUsage }: { contextUsage: ContextUsage | null }) {
	const { t } = useTranslation();
	return (
		<section className="border-b border-border-subtle px-4 py-3">
			<div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs">
				<h3 className="flex items-center gap-2 text-text-muted">
					<Layers className="size-3.5" aria-hidden="true" />
					{t("session.context")}
				</h3>
				{contextUsage ? (
					<span className="tabular-nums text-text-muted">
						{contextUsage.used} / {contextUsage.total}
						<span
							className={cn(
								"ml-3 font-medium",
								contextUsage.percent >= 90
									? "text-context-high"
									: contextUsage.percent >= 70
										? "text-context-medium"
										: "text-text-primary",
							)}
						>
							{contextUsage.percent}%
						</span>
					</span>
				) : (
					<span className="text-text-muted">{t("session.usageContextUnavailable")}</span>
				)}
			</div>
			{contextUsage && (
				<div
					className="mt-2 h-1 overflow-hidden rounded-full bg-surface-hover"
					role="progressbar"
					aria-label={t("session.context")}
					aria-valuemin={0}
					aria-valuemax={100}
					aria-valuenow={contextUsage.percent}
				>
					<div
						className={cn(
							"h-full origin-left rounded-full transition-transform duration-200 motion-reduce:transition-none",
							contextUsage.percent >= 90
								? "bg-context-high"
								: contextUsage.percent >= 70
									? "bg-context-medium"
									: "bg-accent/70",
						)}
						style={{ transform: `scaleX(${contextUsage.percent / 100})` }}
					/>
				</div>
			)}
		</section>
	);
}

export function SessionUsageDetails({
	messages,
	contextUsage,
}: {
	messages: readonly SessionMessage[];
	contextUsage: ContextUsage | null;
}) {
	const { t, i18n } = useTranslation();
	const language = i18n.resolvedLanguage ?? i18n.language;
	const analysis = useMemo(() => analyzeSessionUsage(messages), [messages]);
	const { summary } = analysis;
	const toolCalls = analysis.tools.reduce((total, tool) => total + tool.calls, 0);
	const toolFailures = analysis.tools.reduce((total, tool) => total + tool.failures, 0);
	return (
		<>
			<div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
				<section className="border-b border-border-subtle px-4 py-4">
					<div className="flex items-end justify-between gap-4">
						<div>
							<h3 className="text-xs text-text-muted">{t("session.usageTokens")}</h3>
							<div
								className="mt-1 text-[1.75rem] leading-none font-semibold tracking-tight tabular-nums text-text-primary"
								title={summary.totalTokens.toLocaleString(language)}
							>
								{formatCompactNumber(summary.totalTokens, language)}
							</div>
						</div>
						<div className="text-right">
							<div className="text-xs text-text-muted">{t("session.usageCost")}</div>
							<div className="mt-1 text-lg font-medium tabular-nums text-text-primary">
								{formatCost(summary.costTotal)}
							</div>
						</div>
					</div>
					<div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-muted">
						<span className="inline-flex items-center gap-1.5">
							<MessageSquare className="size-3" aria-hidden="true" />
							{t("session.usageResponsesCompact", { count: summary.turns })}
						</span>
						<span className="inline-flex items-center gap-1.5">
							<Wrench className="size-3" aria-hidden="true" />
							{t("session.usageToolsCompact", { calls: toolCalls, failures: toolFailures })}
						</span>
					</div>
				</section>
				<ContextPanel contextUsage={contextUsage} />
				<div className="divide-y divide-border-subtle">
					<DisclosureRow icon={<PieChart />} title={t("session.usageTokenMix")}>
						<SessionTokenMix summary={summary} />
					</DisclosureRow>
					<DisclosureRow icon={<TrendingUp />} title={t("session.usageTimeline")} defaultOpen>
						<SessionTokenTimeline events={analysis.events} />
					</DisclosureRow>
					<DisclosureRow
						icon={<Cpu />}
						title={t("session.usageModels")}
						summary={analysis.models.length.toLocaleString(language)}
					>
						<SessionModelBreakdown models={analysis.models} totalTokens={summary.totalTokens} />
						{analysis.unattributedTokens > 0 && (
							<p className="mt-2 text-xs text-text-muted">
								{t("session.usageUnattributedModel", {
									amount: formatCompactNumber(analysis.unattributedTokens, language),
								})}
							</p>
						)}
					</DisclosureRow>
					<DisclosureRow icon={<Wrench />} title={t("session.usageTools")} summary={toolCalls.toLocaleString(language)}>
						<SessionToolBreakdown tools={analysis.tools} />
					</DisclosureRow>
				</div>
			</div>
			{summary.compactions > 0 && (
				<footer className="shrink-0 border-t border-border-subtle px-4 py-2 text-xs text-text-muted">
					{t("session.usageCompactions")}: {summary.compactions.toLocaleString(language)}
				</footer>
			)}
		</>
	);
}
