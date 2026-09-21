import { formatCompactNumber } from "@renderer/lib/format-number";
import type { UsageDayStat, UsageHeatmapCell } from "@ling/contracts/usage";
import { TooltipSurface } from "@renderer/components/ui/tooltip";
import { type CSSProperties, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Pie, PieChart, Sector, Tooltip, type PieSectorShapeProps } from "recharts";
import { formatDayLabel } from "./usage-format";
import { heatmapCellColor, heatmapLevel, niceMax, type StackedDay, type UsageSeries } from "./usage-view-model";
import { UsageCartesianChart, type UsagePlotSeries } from "./usage-cartesian-chart";

/** The calendar has discrete cells; its popup shares the chart tooltip surface. */
function ChartTip({ style, children }: { style: CSSProperties; children: ReactNode }) {
	return (
		<TooltipSurface style={style} className="pointer-events-none absolute z-10 w-max max-w-64">
			{children}
		</TooltipSurface>
	);
}

/** Heatmap cell edge length (px), matching Tailwind size-3.5. */
const CELL_PX = 14;
/** Cell gap (px), matching gap-1.5. */
const CELL_GAP_PX = 6;
/** Cell pitch = edge length + gap; scrolling/layout computes column width from the pitch. */
const CELL_PITCH_PX = CELL_PX + CELL_GAP_PX;

interface HeatmapProps {
	cells: UsageHeatmapCell[];
	language: string;
	noActivityLabel: string;
	tokensLabel: (formatted: string) => string;
}

export function UsageHeatmap({ cells, language, noActivityLabel, tokensLabel }: HeatmapProps) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const [hovered, setHovered] = useState<{ week: number; day: number; cell: UsageHeatmapCell } | null>(null);

	const { weeks, maxTokens } = useMemo(() => {
		const chunked: (UsageHeatmapCell | null)[][] = [];
		for (let i = 0; i < cells.length; i += 7) {
			const week: (UsageHeatmapCell | null)[] = cells.slice(i, i + 7);
			while (week.length < 7) week.push(null);
			chunked.push(week);
		}
		return { weeks: chunked, maxTokens: Math.max(0, ...cells.map((c) => c.totalTokens)) };
	}, [cells]);

	// Most recent weeks matter most — start scrolled to the right end.
	useEffect(() => {
		const el = scrollRef.current;
		if (el) el.scrollLeft = el.scrollWidth;
	}, []);

	return (
		<div ref={scrollRef} className="overflow-x-auto">
			<div className="relative min-w-max pr-1 pt-1">
				<div className="flex gap-1.5">
					{weeks.map((week, weekIndex) => (
						// eslint-disable-next-line react/no-array-index-key -- weeks are a fixed positional grid
						<div key={weekIndex} className="flex flex-col gap-1.5">
							{week.map((cell, dayIndex) =>
								cell ? (
									<div
										key={cell.date}
										role="img"
										aria-label={`${cell.date}: ${cell.totalTokens}`}
										className="size-3.5 rounded-sm transition-transform motion-reduce:transition-none hover:scale-110 motion-reduce:hover:scale-100"
										style={{ backgroundColor: heatmapCellColor(heatmapLevel(cell.totalTokens, maxTokens)) }}
										onMouseEnter={() => setHovered({ week: weekIndex, day: dayIndex, cell })}
										onMouseLeave={() => setHovered(null)}
									/>
								) : (
									// eslint-disable-next-line react/no-array-index-key -- trailing pad cells of the last week
									<div key={`pad-${dayIndex}`} className="size-3.5" />
								),
							)}
						</div>
					))}
				</div>
				{hovered && (
					<ChartTip
						// The scroll container clips overflow on both axes, so tooltips on the top
						// rows open downward and edge columns shift sideways instead of centering.
						style={{
							left: hovered.week * CELL_PITCH_PX + CELL_PX / 2,
							top: hovered.day < 2 ? (hovered.day + 1) * CELL_PITCH_PX + 2 : hovered.day * CELL_PITCH_PX - 4,
							transform: `translate(${
								hovered.week > weeks.length - 8 ? "-90%" : hovered.week < 8 ? "-10%" : "-50%"
							}, ${hovered.day < 2 ? "0" : "-100%"})`,
						}}
					>
						<span className="font-medium">{formatDayLabel(hovered.cell.date, language)}</span>
						<span className="mx-1.5 opacity-60">·</span>
						{hovered.cell.active
							? tokensLabel(formatCompactNumber(hovered.cell.totalTokens, language))
							: noActivityLabel}
					</ChartTip>
				)}
			</div>
		</div>
	);
}

/** The less → more legend swatches (levels 0–4). */
export function HeatmapLegendSwatches() {
	return (
		<>
			{([0, 1, 2, 3, 4] as const).map((level) => (
				<div key={level} className="size-3.5 rounded-sm" style={{ backgroundColor: heatmapCellColor(level) }} />
			))}
		</>
	);
}

interface BarChartProps {
	days: StackedDay[];
	series: UsageSeries[];
	yMax: number;
	language: string;
	emptyLabel: string;
}

export function UsageBarChart({ days, series, yMax, language, emptyLabel }: BarChartProps) {
	const rows = days.map((day) => ({
		key: day.date,
		label: formatDayLabel(day.date, language),
		values: series.map((item) => {
			// Zero-token model segments are intentionally omitted by buildStackedDays.
			const segment = day.segments.find((segment) => segment.key === item.key);
			return segment ? segment.tokens : 0;
		}),
	}));
	return (
		<UsageCartesianChart
			rows={rows}
			series={series.map((item) => ({ ...item, kind: "bar" }))}
			yMax={yMax}
			language={language}
			emptyLabel={emptyLabel}
		/>
	);
}

interface DonutProps {
	series: UsageSeries[];
	centerValue: string;
	centerCaption: string;
	language: string;
	ariaLabel: string;
}

export function UsageDonut({ series, centerValue, centerCaption, language, ariaLabel }: DonutProps) {
	const shown = series.filter((item) => item.totalTokens > 0);
	// An empty ring represents a successful zero-usage result, with no synthetic tooltip value.
	const data = shown.length
		? shown.map((item) => ({ ...item, fill: item.color }))
		: [{ key: "empty", label: "", totalTokens: 1, fill: "var(--color-surface-raised)" }];
	return (
		<div className="relative mx-auto size-56">
			<PieChart width={224} height={224} aria-label={ariaLabel}>
				<Pie
					data={data}
					dataKey="totalTokens"
					nameKey="label"
					innerRadius={70}
					outerRadius={98}
					startAngle={90}
					endAngle={-270}
					paddingAngle={shown.length > 1 ? 1.4 : 0}
					stroke="none"
					isAnimationActive={false}
					shape={(props: PieSectorShapeProps) => (
						<Sector
							cx={props.cx}
							cy={props.cy}
							startAngle={props.startAngle}
							endAngle={props.endAngle}
							fill={data[props.index]!.fill}
							stroke="none"
							innerRadius={props.innerRadius - (props.isActive && shown.length ? 2 : 0)}
							outerRadius={props.outerRadius + (props.isActive && shown.length ? 2 : 0)}
						/>
					)}
				/>
				<Tooltip
					isAnimationActive={false}
					content={({ active, activeIndex }) => {
						const item = active ? shown[Number(activeIndex)] : undefined;
						return item ? (
							<TooltipSurface>
								<span className="font-medium">{item.label}</span>
								<span className="mx-1.5 opacity-60">·</span>
								{formatCompactNumber(item.totalTokens, language)}
							</TooltipSurface>
						) : null;
					}}
				/>
			</PieChart>
			<div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
				<div className="text-xl font-semibold text-text-primary">{centerValue}</div>
				<div className="text-xs text-text-muted">{centerCaption}</div>
			</div>
		</div>
	);
}

interface TrendChartProps {
	days: UsageDayStat[];
	language: string;
	emptyLabel: string;
	labels: { total: string; input: string; output: string; cacheRead: string; cacheWrite: string };
}

export function UsageTrendChart({ days, language, emptyLabel, labels }: TrendChartProps) {
	// The total is neutral ink; categorical hues and legend order match the today card.
	const series: UsagePlotSeries[] = [
		{ key: "input", label: labels.input, color: "var(--color-chart-1)", kind: "bar" },
		{ key: "output", label: labels.output, color: "var(--color-chart-5)", kind: "bar" },
		{ key: "cacheWrite", label: labels.cacheWrite, color: "var(--color-chart-3)", kind: "bar" },
		{ key: "cacheRead", label: labels.cacheRead, color: "var(--color-chart-2)", kind: "bar" },
	];
	const rows = days.map((day) => ({
		key: day.date,
		label: formatDayLabel(day.date, language),
		values: [day.inputTokens, day.outputTokens, day.cacheWriteTokens, day.cacheReadTokens],
	}));
	return (
		<div>
			<UsageCartesianChart
				rows={rows}
				series={series}
				yMax={niceMax(Math.max(0, ...days.map((day) => day.totalTokens)))}
				language={language}
				emptyLabel={emptyLabel}
			/>
			<div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5">
				{series.map((item) => (
					<div key={item.key} className="flex items-center gap-2 text-xs">
						<span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: item.color }} />
						<span className="text-text-muted">{item.label}</span>
					</div>
				))}
			</div>
		</div>
	);
}
