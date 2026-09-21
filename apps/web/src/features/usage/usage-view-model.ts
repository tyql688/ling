import type { UsageStatsSnapshot } from "@ling/contracts/usage";
import { usageModelKey } from "@ling/contracts/usage";

/** Maximum number of distinct model series shown in the charts; the rest fold into the "other" bucket to keep the legend small. */
export const MAX_MODEL_SERIES = 8;
/** Internal key of the "other" series; isolated from the real model id namespace. */
const OTHER_SERIES_KEY = "__other__";

export interface UsageSeries {
	key: string;
	/** Display name — the model id, or OTHER_SERIES_KEY's translated label (caller supplies). */
	label: string;
	/** CSS color value (a chart palette var). */
	color: string;
	totalTokens: number;
	/** 0..1 share of the range total; 0 when the range total is 0. */
	share: number;
	assistantMessages: number;
}

export interface StackedDay {
	date: string;
	totalTokens: number;
	/** Bottom-to-top segments, same order as the series list. Zero-token segments omitted. */
	segments: { key: string; tokens: number; color: string }[];
}

export function chartColor(slot: number): string {
	return `var(--color-chart-${slot + 1})`;
}

/** Color token reserved for the "other" bucket, so it never collides with the chart-1..8 ranking slots. */
const OTHER_SERIES_COLOR = "var(--color-chart-other)";

/**
 * Palette slots follow the model's rank over the whole heatmap window (snapshot.paletteOrder),
 * so flipping 7↔30 days never repaints a model that stays visible. Models absent from the
 * window ranking's first eight slots take the lowest unused slot instead.
 */
function assignColorSlots(displayKeys: string[], paletteOrder: string[]): Map<string, number> {
	const slots = new Map<string, number>();
	const used = new Set<number>();
	for (const key of displayKeys) {
		const preferred = paletteOrder.indexOf(key);
		if (preferred >= 0 && preferred < MAX_MODEL_SERIES && !used.has(preferred)) {
			slots.set(key, preferred);
			used.add(preferred);
		}
	}
	for (const key of displayKeys) {
		if (slots.has(key)) continue;
		let slot = 0;
		while (used.has(slot)) slot += 1;
		slots.set(key, slot);
		used.add(slot);
	}
	return slots;
}

/** Top models by range tokens as colored series; the remainder folds into an "other" bucket. */
export function buildUsageSeries(snapshot: UsageStatsSnapshot, otherLabel: string): UsageSeries[] {
	const shown = snapshot.models.slice(0, MAX_MODEL_SERIES);
	const rest = snapshot.models.slice(MAX_MODEL_SERIES);
	const slots = assignColorSlots(
		shown.map((model) => usageModelKey(model.provider, model.model)),
		snapshot.paletteOrder,
	);
	const total = snapshot.totalTokens;

	const series: UsageSeries[] = shown.map((model) => {
		const key = usageModelKey(model.provider, model.model);
		const slot = slots.get(key);
		if (slot === undefined) throw new Error(`No color slot assigned for ${model.provider}/${model.model}`);
		return {
			key,
			label: model.model,
			color: chartColor(slot),
			totalTokens: model.totalTokens,
			share: total > 0 ? model.totalTokens / total : 0,
			assistantMessages: model.assistantMessages,
		};
	});

	const shownTokens = shown.reduce((sum, model) => sum + model.totalTokens, 0);
	const otherTokens = Math.max(0, total - shownTokens);
	if (otherTokens > 0) {
		series.push({
			key: OTHER_SERIES_KEY,
			label: otherLabel,
			color: OTHER_SERIES_COLOR,
			totalTokens: otherTokens,
			share: total > 0 ? otherTokens / total : 0,
			assistantMessages: rest.reduce((sum, m) => sum + m.assistantMessages, 0),
		});
	}
	return series;
}

/** Per-day stacks in series order; unattributed tokens (rare) land in the "other" segment. */
export function buildStackedDays(snapshot: UsageStatsSnapshot, series: UsageSeries[]): StackedDay[] {
	return snapshot.days.map((day) => {
		const segments: StackedDay["segments"] = [];
		let attributed = 0;
		for (const s of series) {
			if (s.key === OTHER_SERIES_KEY) continue;
			const tokens = day.byModel[s.key];
			if (tokens === undefined || tokens <= 0) continue;
			attributed += tokens;
			segments.push({ key: s.key, tokens, color: s.color });
		}
		const otherTokens = day.totalTokens - attributed;
		if (otherTokens > 0) segments.push({ key: OTHER_SERIES_KEY, tokens: otherTokens, color: OTHER_SERIES_COLOR });
		return { date: day.date, totalTokens: day.totalTokens, segments };
	});
}

/** Smallest "nice" axis maximum (1/2/5 × 10^k) at or above the data maximum; 1 for empty data. */
export function niceMax(maxValue: number): number {
	if (maxValue <= 0) return 1;
	const magnitude = 10 ** Math.floor(Math.log10(maxValue));
	for (const step of [1, 2, 5, 10]) {
		if (maxValue <= step * magnitude) return step * magnitude;
	}
	return 10 * magnitude;
}

/** Heatmap intensity 0–4: 0 = no tokens, then quartiles of the window's max day. */
export function heatmapLevel(tokens: number, maxTokens: number): 0 | 1 | 2 | 3 | 4 {
	if (tokens <= 0 || maxTokens <= 0) return 0;
	const ratio = tokens / maxTokens;
	if (ratio <= 0.25) return 1;
	if (ratio <= 0.5) return 2;
	if (ratio <= 0.75) return 3;
	return 4;
}

/** color-mix percentages of chart-1 for heatmap levels 0–4; level 0 uses the plain surface. */
const HEATMAP_MIX_PERCENT = [0, 18, 36, 58, 82] as const;

export function heatmapCellColor(level: 0 | 1 | 2 | 3 | 4): string {
	const percent = HEATMAP_MIX_PERCENT[level];
	if (percent === 0) return "var(--color-surface-raised)";
	return `color-mix(in oklab, var(--color-chart-1) ${percent}%, var(--color-surface-raised))`;
}
