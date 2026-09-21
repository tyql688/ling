import { formatCompactNumber } from "@renderer/lib/format-number";
import { TooltipSurface } from "@renderer/components/ui/tooltip";
import {
	Area,
	Bar,
	CartesianGrid,
	ComposedChart,
	Line,
	ReferenceDot,
	ReferenceLine,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";

interface UsagePlotRow {
	key: string;
	label: string;
	/** Indexed series avoid interpreting provider/model identities as nested object paths. */
	values: number[];
}

export interface UsagePlotSeries {
	key: string;
	label: string;
	color: string;
	kind: "bar" | "line" | "area";
	cumulative?: boolean;
}

interface ChartSelection {
	index: number;
	onSelect(index: number): void;
	onHover(index: number | null): void;
	ariaLabel: string;
}

/** Recharts owns geometry, interpolation, stacking, hit testing and responsive axes for both usage views. */
export function UsageCartesianChart({
	rows,
	series,
	yMax,
	cumulativeMax,
	language,
	emptyLabel,
	height = 252,
	ticks,
	selection,
}: {
	rows: UsagePlotRow[];
	series: UsagePlotSeries[];
	yMax: number;
	cumulativeMax?: number;
	language: string;
	emptyLabel?: string;
	height?: number;
	ticks?: number[];
	selection?: ChartSelection;
}) {
	const empty = rows.every((row) => row.values.every((value) => value === 0));
	const selected = selection ? rows[selection.index] : undefined;
	const cumulativeIndex = series.findIndex((item) => item.cumulative);
	// At most eight date labels, anchored to the latest day; session charts supply three time ticks.
	const labelStep = Math.max(1, Math.ceil(rows.length / 8));
	const axisTicks = rows
		.filter((_row, index) => (ticks ? ticks.includes(index) : (rows.length - 1 - index) % labelStep === 0))
		.map((row) => row.key);
	const indexOf = (value: string | number | undefined | null): number | null => {
		if (value === undefined || value === null) return null;
		const index = Number(value);
		return Number.isSafeInteger(index) && index >= 0 && index < rows.length ? index : null;
	};
	return (
		<div
			className="relative min-w-0 outline-none focus-visible:ring-1 focus-visible:ring-border-strong"
			style={{ height }}
			tabIndex={selection ? 0 : undefined}
			role={selection ? "group" : undefined}
			aria-label={selection?.ariaLabel}
			onKeyDown={(event) => {
				if (!selection) return;
				let index: number;
				switch (event.key) {
					case "ArrowLeft":
					case "ArrowUp":
						index = Math.max(0, selection.index - 1);
						break;
					case "ArrowRight":
					case "ArrowDown":
						index = Math.min(rows.length - 1, selection.index + 1);
						break;
					case "Home":
						index = 0;
						break;
					case "End":
						index = rows.length - 1;
						break;
					default:
						return;
				}
				event.preventDefault();
				selection.onHover(null);
				selection.onSelect(index);
			}}
		>
			<ResponsiveContainer width="100%" height="100%" minWidth={0}>
				<ComposedChart
					data={rows}
					margin={{ top: 12, right: 14, bottom: 0, left: 0 }}
					accessibilityLayer={!selection}
					aria-hidden={selection ? true : undefined}
					onMouseMove={(state) => {
						if (selection) selection.onHover(indexOf(state.activeTooltipIndex));
					}}
					onMouseLeave={() => selection?.onHover(null)}
					onClick={(state) => {
						const index = indexOf(state.activeTooltipIndex);
						if (index !== null) selection?.onSelect(index);
					}}
				>
					<CartesianGrid vertical={false} stroke="var(--color-border-subtle)" />
					<XAxis
						dataKey="key"
						ticks={axisTicks}
						axisLine={false}
						tickLine={false}
						minTickGap={16}
						tick={{ fontSize: 12, fill: "var(--color-text-muted)" }}
						height={28}
						tickFormatter={(key: string) => rows.find((row) => row.key === key)?.label ?? key}
					/>
					<YAxis
						domain={[0, yMax]}
						ticks={[0, yMax / 2, yMax]}
						width={50}
						axisLine={false}
						tickLine={false}
						tick={{ fontSize: 12, fill: "var(--color-text-muted)" }}
						tickFormatter={(value: number) => formatCompactNumber(value, language)}
					/>
					{cumulativeMax !== undefined && <YAxis yAxisId="cumulative" hide domain={[0, cumulativeMax]} />}
					{series.map((item, index) => {
						const shared = {
							dataKey: `values.${index}`,
							name: item.label,
							yAxisId: item.cumulative ? "cumulative" : 0,
							isAnimationActive: false,
						};
						switch (item.kind) {
							case "bar":
								return <Bar key={item.key} {...shared} stackId="tokens" fill={item.color} maxBarSize={24} />;
							case "line":
								return (
									<Line
										key={item.key}
										{...shared}
										type="monotone"
										stroke={item.color}
										strokeWidth={2}
										dot={rows.length === 1}
									/>
								);
							case "area":
								return (
									<Area
										key={item.key}
										{...shared}
										type={item.cumulative ? "linear" : "monotone"}
										fill={item.color}
										fillOpacity={0.06}
										stroke={item.color}
										strokeWidth={1.5}
										dot={rows.length === 1}
									/>
								);
						}
					})}
					<Tooltip
						isAnimationActive={false}
						cursor={{ stroke: "var(--color-border-strong)", fill: "var(--color-surface-hover)" }}
						content={({ active, activeIndex }) => {
							const index = indexOf(activeIndex);
							const row = active && index !== null ? rows[index] : undefined;
							if (selection || !row || empty) return null;
							return (
								<TooltipSurface className="max-w-64">
									<div className="mb-0.5 font-medium">{row.label}</div>
									{series.map((item, index) => (
										<div key={item.key} className="flex items-center gap-1.5">
											<span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: item.color }} />
											<span className="min-w-0 truncate">{item.label}</span>
											<span className="ml-auto pl-3 tabular-nums">
												{formatCompactNumber(row.values[index]!, language)}
											</span>
										</div>
									))}
								</TooltipSurface>
							);
						}}
					/>
					{selected && <ReferenceLine x={selected.key} stroke="var(--color-text-muted)" strokeDasharray="2 3" />}
					{selected && cumulativeIndex >= 0 && (
						<ReferenceDot
							x={selected.key}
							y={selected.values[cumulativeIndex]!}
							yAxisId="cumulative"
							r={3}
							fill="var(--color-surface-raised)"
							stroke="var(--color-accent)"
						/>
					)}
				</ComposedChart>
			</ResponsiveContainer>
			{empty && emptyLabel && (
				<div className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-text-muted">
					{emptyLabel}
				</div>
			)}
		</div>
	);
}
