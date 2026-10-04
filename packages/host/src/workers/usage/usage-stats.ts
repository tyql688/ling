import type {
	UsageDayStat,
	UsageHeatmapCell,
	UsageModelStat,
	UsageRangeDays,
	UsageStatsSnapshot,
} from "@ling/contracts/usage";
import { usageModelKey } from "@ling/contracts/usage";
import {
	parseUsageRecord,
	type UsageScanner,
	type UsageBreakdown,
	type UsageRecord,
} from "@ling/host/workers/usage/usage-scan";

/** Aggregates dated token usage from Ling and Pi CLI sessions in the shared agent directory. usage-scan.ts reads and caches files; this module applies date windows and totals. */

/** The heatmap spans 53 weeks, about a year plus a boundary week. Fixed ranges scan this window; all-time scans the complete history. */
const HEATMAP_WEEKS = 53;

function dateKeyOf(date: Date): string {
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
}

function startOfDay(date: Date): Date {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date: Date, days: number): Date {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

/** Monday of the week containing `date` (local time). */
function mondayOf(date: Date): Date {
	const weekday = (date.getDay() + 6) % 7; // Monday = 0
	return addDays(date, -weekday);
}

function heatmapCutoffMs(now: Date): number {
	return addDays(mondayOf(startOfDay(now)), -(HEATMAP_WEEKS - 1) * 7).getTime();
}

interface UsageAccumulator {
	/** Call once before feeding a file's lines; `fileId` seeds the dedupe fallback key. */
	beginFile(fileId: string): void;
	/** Call once after a file's lines; counts the session if it had in-range activity. */
	endFile(): void;
	addLine(line: string): void;
	addRecord(record: UsageRecord): void;
	snapshot(): UsageStatsSnapshot;
}

/** Accumulates usage from session JSONL. Skips entries without recognized numeric usage.totalTokens and reports malformed JSON as a file-scan failure. Deduplicates copied fork history by entryId:messageTimestamp. Counts a session after its first nonduplicate message within the selected range. */
function createUsageAccumulator(now: Date, rangeDays: UsageRangeDays): UsageAccumulator {
	const today = startOfDay(now);
	const todayKey = dateKeyOf(today);
	const rangeStartMs = rangeDays === "all" ? 0 : addDays(today, -(rangeDays - 1)).getTime();
	const heatmapStart = addDays(mondayOf(today), -(HEATMAP_WEEKS - 1) * 7);
	const heatmapStartMs = heatmapStart.getTime();
	// Ingestion floor: the heatmap window normally bounds it, but the all-time range must see everything.
	const ingestStartMs = Math.min(heatmapStartMs, rangeStartMs);
	// Exclude messages timestamped after the end of today, including those caused by clock skew.
	const endMs = addDays(today, 1).getTime();

	const seenMessages = new Set<string>();
	const dayUsage = new Map<string, UsageBreakdown>();
	const activeDayKeys = new Set<string>();
	const rangeDayModelTokens = new Map<string, Map<string, number>>();
	const rangeModels = new Map<string, UsageModelStat>();
	const windowModelTokens = new Map<string, number>();

	let totalTokens = 0;
	let userMessageCount = 0;
	let sessionCount = 0;

	let fileId = "";
	let lineNo = 0;
	let fileHasRangeActivity = false;

	function addRecord(record: UsageRecord): void {
		const ts = record.timestampMs;
		// Drop what no output can observe, before dedupe: for a fixed range that is everything
		// older than the 53-week heatmap, which keeps years of copied fork history out of this
		// Set. The all-time range has no such floor; it must see every message, so the Set
		// grows with the whole on-disk history (tens of thousands of entries on a busy machine).
		if (ts < ingestStartMs || ts >= endMs) return;
		if (seenMessages.has(record.dedupeKey)) return;
		seenMessages.add(record.dedupeKey);

		const inRange = ts >= rangeStartMs;
		if (record.role === "user") {
			if (inRange) {
				userMessageCount += 1;
				fileHasRangeActivity = true;
			}
			return;
		}

		if (record.usage === null) return;
		const { usage } = record;
		const tokens = usage.totalTokens;
		const attribution =
			record.provider !== null && record.model !== null
				? {
						provider: record.provider,
						model: record.model,
						key: usageModelKey(record.provider, record.model),
					}
				: null;
		const dayKey = dateKeyOf(new Date(ts));

		const existingDayUsage = dayUsage.get(dayKey);
		if (existingDayUsage) {
			existingDayUsage.totalTokens += usage.totalTokens;
			existingDayUsage.inputTokens += usage.inputTokens;
			existingDayUsage.outputTokens += usage.outputTokens;
			existingDayUsage.cacheReadTokens += usage.cacheReadTokens;
			existingDayUsage.cacheWriteTokens += usage.cacheWriteTokens;
			existingDayUsage.cost += usage.cost;
		} else {
			dayUsage.set(dayKey, { ...usage });
		}
		activeDayKeys.add(dayKey);
		if (attribution) {
			windowModelTokens.set(attribution.key, (windowModelTokens.get(attribution.key) ?? 0) + tokens);
		}

		if (inRange) {
			fileHasRangeActivity = true;
			totalTokens += tokens;
			if (attribution) {
				const existing = rangeModels.get(attribution.key);
				if (existing) {
					existing.totalTokens += tokens;
					existing.assistantMessages += record.source === "assistant" ? 1 : 0;
				} else {
					rangeModels.set(attribution.key, {
						provider: attribution.provider,
						model: attribution.model,
						totalTokens: tokens,
						assistantMessages: record.source === "assistant" ? 1 : 0,
					});
				}
				let perModel = rangeDayModelTokens.get(dayKey);
				if (!perModel) {
					perModel = new Map();
					rangeDayModelTokens.set(dayKey, perModel);
				}
				perModel.set(attribution.key, (perModel.get(attribution.key) ?? 0) + tokens);
			}
		}
	}

	function addLine(line: string): void {
		lineNo += 1;
		const record = parseUsageRecord(line, fileId, lineNo);
		if (record) addRecord(record);
	}

	function snapshot(): UsageStatsSnapshot {
		const days: UsageDayStat[] = [];
		let activeDays = 0;
		// All-time spans from the earliest observed usage day; a machine with no history shows just today.
		let spanDays: number;
		if (rangeDays === "all") {
			const earliestKey = [...activeDayKeys].toSorted()[0];
			if (earliestKey === undefined) {
				spanDays = 1;
			} else {
				const [year, month, day] = earliestKey.split("-").map(Number);
				const earliest = new Date(year ?? today.getFullYear(), (month ?? 1) - 1, day ?? 1);
				spanDays = Math.min(10_000, Math.max(1, Math.round((today.getTime() - earliest.getTime()) / 86_400_000) + 1));
			}
		} else {
			spanDays = rangeDays;
		}
		for (let offset = spanDays - 1; offset >= 0; offset -= 1) {
			const date = addDays(today, -offset);
			const dateKey = dateKeyOf(date);
			if (activeDayKeys.has(dateKey)) activeDays += 1;
			const byModel: Record<string, number> = {};
			for (const [key, tokens] of rangeDayModelTokens.get(dateKey) ?? []) byModel[key] = tokens;
			const usage = dayUsage.get(dateKey);
			days.push({
				date: dateKey,
				totalTokens: usage?.totalTokens ?? 0,
				inputTokens: usage?.inputTokens ?? 0,
				outputTokens: usage?.outputTokens ?? 0,
				cacheReadTokens: usage?.cacheReadTokens ?? 0,
				cacheWriteTokens: usage?.cacheWriteTokens ?? 0,
				cost: usage?.cost ?? 0,
				byModel,
			});
		}

		let currentStreak = 0;
		if (activeDayKeys.has(todayKey)) {
			let cursor = today;
			while (activeDayKeys.has(dateKeyOf(cursor))) {
				currentStreak += 1;
				cursor = addDays(cursor, -1);
			}
		}

		const heatmap: UsageHeatmapCell[] = [];
		for (let cursor = heatmapStart; cursor.getTime() <= today.getTime(); cursor = addDays(cursor, 1)) {
			const dateKey = dateKeyOf(cursor);
			heatmap.push({
				date: dateKey,
				totalTokens: dayUsage.get(dateKey)?.totalTokens ?? 0,
				active: activeDayKeys.has(dateKey),
			});
		}

		const models = [...rangeModels.values()].toSorted((a, b) => b.totalTokens - a.totalTokens);
		const paletteOrder = [...windowModelTokens.entries()].toSorted((a, b) => b[1] - a[1]).map(([key]) => key);

		return {
			rangeDays,
			skippedFileCount: 0,
			totalTokens,
			sessionCount,
			userMessageCount,
			activeDays,
			currentStreak,
			models,
			days,
			heatmap,
			paletteOrder,
		};
	}

	return {
		beginFile(nextFileId: string): void {
			fileId = nextFileId;
			lineNo = 0;
			fileHasRangeActivity = false;
		},
		endFile(): void {
			if (fileHasRangeActivity) sessionCount += 1;
		},
		addLine,
		addRecord,
		snapshot,
	};
}

export async function getUsageStats(
	rangeDays: UsageRangeDays,
	sessionDirectories: readonly string[],
	scanner: UsageScanner,
): Promise<UsageStatsSnapshot> {
	const now = new Date();
	const scan = await scanner.scanFiles(sessionDirectories, rangeDays === "all" ? 0 : heatmapCutoffMs(now));
	const accumulator = createUsageAccumulator(now, rangeDays);
	for (const file of scan.files) {
		accumulator.beginFile(file.filePath);
		for (const record of file.records) accumulator.addRecord(record);
		accumulator.endFile();
	}
	return { ...accumulator.snapshot(), skippedFileCount: scan.skippedFileCount };
}
