import { formatCompactNumber } from "@renderer/lib/format-number";
import { useDomainApi } from "@renderer/lib/host-api-context";
import type { UsageRangeDays, UsageStatsSnapshot } from "@ling/contracts/usage";
import { errorMessage } from "@ling/contracts/ling-error";
import { AnimatedNumber } from "@renderer/components/ui/animated-number";
import { Button } from "@renderer/components/ui/button";
import { FeedbackNotice } from "@renderer/components/ui/feedback";
import { LoadingTransition } from "@renderer/components/ui/loading-transition";
import { Segmented } from "@renderer/components/ui/segmented";
import { SettingsPage } from "@renderer/components/ui/settings-page";
import { SettingsRetryAction, SettingsState } from "@renderer/components/ui/settings-state";
import { cn } from "@renderer/lib/utils";
import {
	Activity,
	CalendarCheck2,
	CalendarDays,
	Flame,
	type LucideIcon,
	MessageCircle,
	MessagesSquare,
	RefreshCw,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { HeatmapLegendSwatches, UsageBarChart, UsageDonut, UsageHeatmap, UsageTrendChart } from "./usage-charts";
import { formatShare } from "./usage-format";
import { buildStackedDays, buildUsageSeries, niceMax } from "./usage-view-model";
import "./session-usage.css";

const roundedAmount = (amount: number): string => Math.round(amount).toString();

function StatTile({ icon: Icon, label, children }: { icon: LucideIcon; label: string; children: React.ReactNode }) {
	return (
		<div className="min-w-0">
			<div className="flex min-w-0 items-center gap-2 text-xs text-text-muted">
				<Icon className="size-3.5 shrink-0" aria-hidden="true" />
				<span className="truncate">{label}</span>
			</div>
			<div className="mt-1.5">{children}</div>
		</div>
	);
}

/** Numeric stat tile: every tile but topModel is this exact shape. */
function StatNumberTile({
	icon,
	label,
	value,
	format = roundedAmount,
}: {
	icon: LucideIcon;
	label: string;
	value: number;
	format?: (amount: number) => string;
}) {
	return (
		<StatTile icon={icon} label={label}>
			<div className="truncate text-xl font-semibold text-text-primary">
				<AnimatedNumber value={value} format={format} />
			</div>
		</StatTile>
	);
}

function UsageSection({
	title,
	action,
	children,
}: {
	title: string;
	action?: React.ReactNode;
	children: React.ReactNode;
}) {
	return (
		<section className="min-w-0 border-t border-border-subtle pt-6">
			<div className="mb-4 flex items-center justify-between gap-3">
				<h3 className="min-w-0 truncate text-sm font-medium text-text-primary">{title}</h3>
				{action}
			</div>
			{children}
		</section>
	);
}

function missingUsageView(): never {
	throw new Error("Usage view projection is missing for a loaded snapshot");
}

export function UsageView() {
	const hostUsageApi = useDomainApi("usage");

	const { t, i18n } = useTranslation();
	const language = i18n.language;
	const [range, setRange] = useState<UsageRangeDays>(7);
	const [snapshot, setSnapshot] = useState<UsageStatsSnapshot | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const requestRevisionRef = useRef(0);
	const currentSnapshot = snapshot?.rangeDays === range ? snapshot : null;

	const load = useCallback(
		async (rangeDays: UsageRangeDays) => {
			requestRevisionRef.current += 1;
			const revision = requestRevisionRef.current;
			setLoading(true);
			setError(null);
			try {
				const next = await hostUsageApi.getStats(rangeDays);
				if (revision === requestRevisionRef.current) setSnapshot(next);
			} catch (cause) {
				if (revision === requestRevisionRef.current) setError(errorMessage(cause));
			} finally {
				if (revision === requestRevisionRef.current) setLoading(false);
			}
		},
		[hostUsageApi],
	);

	useEffect(() => {
		void load(range);
		return () => {
			requestRevisionRef.current += 1;
		};
	}, [load, range]);

	const view = useMemo(() => {
		if (!currentSnapshot) return null;
		const series = buildUsageSeries(currentSnapshot, t("usage.otherModels"));
		return {
			series,
			stackedDays: buildStackedDays(currentSnapshot, series),
			yMax: niceMax(Math.max(0, ...currentSnapshot.days.map((day) => day.totalTokens))),
			topModel: currentSnapshot.models[0],
		};
	}, [currentSnapshot, t]);
	return (
		<SettingsPage
			title={t("settings.usage")}
			description={t("settings.usageDescription")}
			actions={
				<Button variant="ghost" size="sm" onClick={() => void load(range)} disabled={loading} aria-busy={loading}>
					<RefreshCw className={cn("size-3.5", loading && "animate-spin")} aria-hidden="true" />
					{t("usage.refresh")}
				</Button>
			}
		>
			{error && currentSnapshot !== null && (
				<FeedbackNotice
					tone="danger"
					title={t("usage.loadFailedTitle")}
					action={<SettingsRetryAction label={t("usage.retry")} onClick={() => void load(range)} disabled={loading} />}
				>
					{error}
				</FeedbackNotice>
			)}
			{currentSnapshot && currentSnapshot.skippedFileCount > 0 && (
				<FeedbackNotice tone="warning">
					{t("usage.incompleteFiles", { count: currentSnapshot.skippedFileCount })}
				</FeedbackNotice>
			)}

			<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
				<span className="text-sm font-medium text-text-primary">{t("usage.timeRange")}</span>
				<Segmented
					variant="plain"
					value={String(range)}
					onChange={(next) => setRange(next === "all" ? "all" : (Number.parseInt(next, 10) as 7 | 14 | 30 | 90))}
					ariaLabel={t("usage.timeRange")}
					options={[
						{ value: "7", label: t("usage.last7Days") },
						{ value: "14", label: t("usage.last14Days") },
						{ value: "30", label: t("usage.last30Days") },
						{ value: "90", label: t("usage.last90Days") },
						{ value: "all", label: t("usage.allTime") },
					]}
				/>
			</div>

			{currentSnapshot === null ? (
				error ? (
					<SettingsState
						icon={Activity}
						title={t("usage.loadFailedTitle")}
						description={error}
						tone="danger"
						action={
							<SettingsRetryAction label={t("usage.retry")} onClick={() => void load(range)} disabled={loading} />
						}
					/>
				) : (
					<LoadingTransition label={t("usage.loading")} />
				)
			) : view === null ? (
				missingUsageView()
			) : currentSnapshot.activeDays === 0 ? (
				<SettingsState icon={Activity} title={t("usage.emptyTitle")} description={t("usage.noData")} />
			) : (
				<>
					<div className="grid grid-cols-2 gap-x-6 gap-y-7 sm:grid-cols-3">
						<StatNumberTile
							icon={Flame}
							label={t("usage.tokensUsed")}
							value={currentSnapshot.totalTokens}
							format={(amount) => formatCompactNumber(amount, language)}
						/>
						<StatNumberTile icon={MessagesSquare} label={t("usage.sessions")} value={currentSnapshot.sessionCount} />
						<StatNumberTile icon={MessageCircle} label={t("usage.messages")} value={currentSnapshot.userMessageCount} />
						<StatNumberTile icon={CalendarDays} label={t("usage.activeDays")} value={currentSnapshot.activeDays} />
						<StatNumberTile
							icon={CalendarCheck2}
							label={t("usage.currentStreak")}
							value={currentSnapshot.currentStreak}
						/>
						<StatTile icon={Activity} label={t("usage.topModel")}>
							{view.topModel ? (
								<>
									<div className="truncate font-mono text-base font-semibold text-text-primary">
										{view.topModel.model}
									</div>
									<div className="text-xs text-text-muted">
										{t("usage.topModelShare", {
											percent: formatShare(
												currentSnapshot.totalTokens > 0 ? view.topModel.totalTokens / currentSnapshot.totalTokens : 0,
											).replace("%", ""),
										})}
									</div>
								</>
							) : (
								<div className="text-xl font-semibold text-text-muted">—</div>
							)}
						</StatTile>
					</div>

					<UsageSection title={t("usage.trendTitle")}>
						<UsageTrendChart
							days={currentSnapshot.days}
							language={language}
							emptyLabel={t("usage.noData")}
							labels={{
								total: t("usage.trendTotal"),
								input: t("session.usageInput"),
								output: t("session.usageOutput"),
								cacheRead: t("session.usageCacheRead"),
								cacheWrite: t("session.usageCacheWrite"),
							}}
						/>
					</UsageSection>

					<UsageSection
						title={t("usage.heatmap")}
						action={
							<div className="flex shrink-0 items-center gap-1.5 text-xs text-text-muted">
								<span>{t("usage.less")}</span>
								<HeatmapLegendSwatches />
								<span>{t("usage.more")}</span>
							</div>
						}
					>
						<UsageHeatmap
							cells={currentSnapshot.heatmap}
							language={language}
							noActivityLabel={t("usage.noActivity")}
							tokensLabel={(formatted) => t("usage.tokensAmount", { amount: formatted })}
						/>
					</UsageSection>

					<UsageSection title={t("usage.dailyTrend")}>
						<UsageBarChart
							days={view.stackedDays}
							series={view.series}
							yMax={view.yMax}
							language={language}
							emptyLabel={t("usage.noData")}
						/>
						{view.series.length > 0 && (
							<div className="mt-3 grid grid-cols-3 gap-x-2 gap-y-1.5">
								{view.series.map((s) => (
									<div key={s.key} className="flex min-w-0 items-center gap-2 text-xs">
										<span className="size-2.5 shrink-0 rounded-sm" style={{ backgroundColor: s.color }} />
										<span className="truncate text-text-muted">{s.label}</span>
									</div>
								))}
							</div>
						)}
					</UsageSection>

					<UsageSection title={t("usage.modelUsage")}>
						<div className="grid gap-6 md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
							<UsageDonut
								series={view.series}
								centerValue={formatCompactNumber(currentSnapshot.totalTokens, language)}
								centerCaption={t("usage.tokens")}
								language={language}
								ariaLabel={t("usage.modelUsage")}
							/>
							<ul className="list-none self-center">
								{view.series.length === 0 && <li className="text-sm text-text-muted">{t("usage.noData")}</li>}
								{view.series.map((s) => (
									<li
										key={s.key}
										className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-0.5 border-b border-border-subtle py-2 last:border-b-0"
									>
										<span className="size-2.5 shrink-0 rounded-sm" style={{ backgroundColor: s.color }} />
										<span className="min-w-0 truncate font-mono text-sm text-text-primary">{s.label}</span>
										<span className="text-sm tabular-nums text-text-muted">{formatShare(s.share)}</span>
										<span className="col-start-2 min-w-0 truncate text-xs text-text-muted">
											{t("usage.tokensAmount", { amount: formatCompactNumber(s.totalTokens, language) })}
										</span>
									</li>
								))}
							</ul>
						</div>
					</UsageSection>
				</>
			)}
		</SettingsPage>
	);
}
