import { formatCompactNumber } from "@renderer/lib/format-number";
import { formatCost } from "@renderer/lib/format";
import { formatShare, formatUsageTime, formatUsageTimeRange } from "@renderer/features/usage/usage-format";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	type SessionUsageBucket,
	type SessionUsageEvent,
	type SessionUsageSummary,
	buildUsageBuckets,
} from "./workspace-session-usage";
import { UsageCartesianChart } from "./usage-cartesian-chart";

type TokenPartKey = "input" | "cacheRead" | "cacheWrite" | "output" | "other";

interface TokenPart {
	key: TokenPartKey;
	color: string;
}

const TOKEN_PARTS: readonly TokenPart[] = [
	{ key: "input", color: "var(--color-chart-1)" },
	{ key: "output", color: "var(--color-chart-5)" },
	{ key: "cacheRead", color: "var(--color-chart-2)" },
	{ key: "cacheWrite", color: "var(--color-chart-3)" },
	{ key: "other", color: "var(--color-chart-other)" },
];

function componentTotal(value: Pick<SessionUsageSummary, "input" | "output" | "cacheRead" | "cacheWrite">): number {
	return value.input + value.output + value.cacheRead + value.cacheWrite;
}

function tokenPartLabel(key: TokenPartKey, t: ReturnType<typeof useTranslation>["t"]): string {
	switch (key) {
		case "input":
			return t("session.usageInput");
		case "output":
			return t("session.usageOutput");
		case "cacheRead":
			return t("session.usageCacheRead");
		case "cacheWrite":
			return t("session.usageCacheWrite");
		case "other":
			return t("session.usageOtherTokens");
	}
}

function timeRangeLabel(bucket: SessionUsageBucket, language: string, includeDate = false): string {
	if (!includeDate) return formatUsageTimeRange(bucket.startTimestamp, bucket.endTimestamp, language);
	const start = formatUsageTime(bucket.startTimestamp, language, true);
	if (bucket.startTimestamp === bucket.endTimestamp) return start;
	return `${start}–${formatUsageTime(bucket.endTimestamp, language, true)}`;
}

export function SessionTokenTimeline({ events }: { events: readonly SessionUsageEvent[] }) {
	const { t, i18n } = useTranslation();
	const language = i18n.resolvedLanguage ?? i18n.language;
	const buckets = useMemo(
		() => buildUsageBuckets(events.filter((event) => event.totalTokens > 0 || event.costTotal > 0)),
		[events],
	);
	const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
	const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
	if (buckets.length === 0) {
		return <p className="py-8 text-center text-xs text-text-muted">{t("session.usageNoTimeline")}</p>;
	}

	const fallbackIndex = buckets.length - 1;
	const resolvedSelected = Math.min(selectedIndex ?? fallbackIndex, fallbackIndex);
	const activeIndex = Math.min(hoveredIndex ?? resolvedSelected, fallbackIndex);
	const activeBucket = buckets[activeIndex] ?? buckets[fallbackIndex];
	if (!activeBucket) return null;
	const maxTokens = Math.max(1, ...buckets.map((bucket) => bucket.total));
	let cumulativeTotal = 0;
	const cumulativeTotals = buckets.map((bucket) => (cumulativeTotal += bucket.total));
	const activeCumulative = cumulativeTotals[activeIndex];
	if (activeCumulative === undefined) throw new Error("Missing cumulative usage bucket");
	const hasOther = buckets.some((bucket) => bucket.other > 0);
	const spansDays =
		new Date(buckets[0]?.startTimestamp ?? 0).toDateString() !==
		new Date(buckets.at(-1)?.endTimestamp ?? 0).toDateString();
	const xTickIndexes = [...new Set([0, Math.floor((buckets.length - 1) / 2), buckets.length - 1])];
	const activeModelIdentities = activeBucket.models.map((model) =>
		model.provider ? `${model.provider}/${model.model}` : model.model,
	);

	return (
		<div>
			<div className="min-w-0">
				<div className="overflow-x-auto pb-1">
					<div style={{ minWidth: `${Math.max(240, buckets.length * 8 + 56)}px` }}>
						<UsageCartesianChart
							height={154}
							language={language}
							yMax={maxTokens}
							cumulativeMax={Math.max(1, cumulativeTotal)}
							ticks={xTickIndexes}
							rows={buckets.map((bucket, index) => ({
								key: `${bucket.startOrdinal}-${bucket.endOrdinal}`,
								label: formatUsageTime(bucket.endTimestamp, language, spansDays),
								values: [...TOKEN_PARTS.map((part) => bucket[part.key]), cumulativeTotals[index]!],
							}))}
							series={[
								...TOKEN_PARTS.map((part) => ({ ...part, label: tokenPartLabel(part.key, t), kind: "bar" as const })),
								{
									key: "cumulative",
									label: t("session.usageCumulative"),
									color: "var(--color-accent)",
									kind: "area",
									cumulative: true,
								},
							]}
							selection={{
								index: activeIndex,
								onSelect: setSelectedIndex,
								onHover: setHoveredIndex,
								ariaLabel: t("session.usageEventAria", {
									time: timeRangeLabel(activeBucket, language, spansDays),
									tokens: activeBucket.total.toLocaleString(language),
									input: activeBucket.input.toLocaleString(language),
									output: activeBucket.output.toLocaleString(language),
									cacheRead: activeBucket.cacheRead.toLocaleString(language),
									cacheWrite: activeBucket.cacheWrite.toLocaleString(language),
									cumulative: activeCumulative.toLocaleString(language),
								}),
							}}
						/>
					</div>

					<ul className="mt-1 flex list-none flex-wrap gap-x-3 gap-y-1" aria-label={t("session.usageTokenMix")}>
						{TOKEN_PARTS.filter((part) => part.key !== "other" || hasOther).map((part) => (
							<li key={part.key} className="inline-flex items-center gap-1.5 text-xs text-text-muted">
								<span className="h-0.5 w-3 rounded-full" style={{ backgroundColor: part.color }} aria-hidden="true" />
								{tokenPartLabel(part.key, t)}
							</li>
						))}
						<li className="inline-flex items-center gap-1.5 text-xs text-text-muted">
							<span className="relative h-2 w-3" aria-hidden="true">
								<span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-accent" />
								<span className="absolute top-1/2 left-1/2 size-1 -translate-1/2 rounded-full bg-accent" />
							</span>
							{t("session.usageCumulative")}
						</li>
					</ul>
				</div>
			</div>

			<div className="mt-2 border-t border-border-subtle pt-2">
				<div className="flex items-start justify-between gap-3">
					<div className="min-w-0">
						<h5 className="truncate text-xs font-semibold text-text-primary">
							{timeRangeLabel(activeBucket, language, spansDays)}
						</h5>
						<div className="mt-0.5 truncate text-xs text-text-muted" title={activeModelIdentities.join(", ")}>
							{activeModelIdentities.length > 0 ? activeModelIdentities.join(", ") : t("session.usageUnknownModel")}
						</div>
					</div>
					<div className="shrink-0 text-right">
						<div className="text-base font-semibold tabular-nums text-text-primary">
							{formatCompactNumber(activeBucket.total, language)}
						</div>
						<div className="mt-0.5 text-xs tabular-nums text-text-muted">
							{formatCost(activeBucket.costTotal)} · {t("session.usageCumulative")}{" "}
							{formatCompactNumber(activeCumulative, language)}
						</div>
					</div>
				</div>
				<dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
					<div>
						<dt className="text-xs text-text-muted">{t("session.usageInput")}</dt>
						<dd className="mt-0.5 text-xs tabular-nums text-text-primary">
							{formatCompactNumber(activeBucket.input, language)}
						</dd>
					</div>
					<div>
						<dt className="text-xs text-text-muted">{t("session.usageOutput")}</dt>
						<dd className="mt-0.5 text-xs tabular-nums text-text-primary">
							{formatCompactNumber(activeBucket.output, language)}
						</dd>
					</div>
					<div>
						<dt className="text-xs text-text-muted">{t("session.usageCacheRead")}</dt>
						<dd className="mt-0.5 text-xs tabular-nums text-text-primary">
							{formatCompactNumber(activeBucket.cacheRead, language)}
						</dd>
					</div>
					<div>
						<dt className="text-xs text-text-muted">{t("session.usageCacheWrite")}</dt>
						<dd className="mt-0.5 text-xs tabular-nums text-text-primary">
							{formatCompactNumber(activeBucket.cacheWrite, language)}
						</dd>
					</div>
				</dl>
			</div>
		</div>
	);
}

export function SessionTokenMix({ summary }: { summary: SessionUsageSummary }) {
	const { t, i18n } = useTranslation();
	const language = i18n.resolvedLanguage ?? i18n.language;
	const components = componentTotal(summary);
	const total = Math.max(summary.totalTokens, components);
	const values: Record<TokenPartKey, number> = {
		input: summary.input,
		output: summary.output,
		cacheRead: summary.cacheRead,
		cacheWrite: summary.cacheWrite,
		other: Math.max(0, total - components),
	};
	const bars = TOKEN_PARTS.filter((part) => values[part.key] > 0);
	const shown = TOKEN_PARTS.filter((part) => part.key !== "other" || values[part.key] > 0);
	if (total <= 0) return <p className="py-6 text-center text-sm text-text-muted">{t("session.usageNoTurns")}</p>;

	return (
		<div>
			<div className="flex h-1.5 overflow-hidden rounded-full bg-surface-hover" aria-hidden="true">
				{bars.map((part) => (
					<span key={part.key} style={{ width: `${(values[part.key] / total) * 100}%`, backgroundColor: part.color }} />
				))}
			</div>
			<ul className="mt-2 list-none divide-y divide-border-subtle">
				{shown.map((part) => {
					const value = values[part.key];
					return (
						<li
							key={part.key}
							className="grid grid-cols-[auto_minmax(0,1fr)_auto_3.5rem] items-center gap-2 py-2 text-xs"
						>
							<span className="size-1.5 rounded-full" style={{ backgroundColor: part.color }} aria-hidden="true" />
							<span className="text-text-muted">{tokenPartLabel(part.key, t)}</span>
							<span className="tabular-nums text-text-primary">{value.toLocaleString(language)}</span>
							<span className="text-right tabular-nums text-text-muted">{formatShare(value / total)}</span>
						</li>
					);
				})}
			</ul>
		</div>
	);
}
