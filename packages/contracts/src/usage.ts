import { z } from "zod";

/** Available report windows: two short-term views, a month, a quarter, or the complete history. */
export const usageRangeDaysSchema = z.union([
	z.literal(7),
	z.literal(14),
	z.literal(30),
	z.literal(90),
	z.literal("all"),
]);
export type UsageRangeDays = z.infer<typeof usageRangeDaysSchema>;

/** Collision-safe opaque key for model usage maps; provider and model IDs may contain slashes. */
export function usageModelKey(provider: string | null, model: string): string {
	return JSON.stringify([provider, model]);
}

export interface UsageModelStat {
	provider: string;
	model: string;
	totalTokens: number;
	assistantMessages: number;
}

export interface UsageDayStat {
	/** YYYY-MM-DD in the machine's local timezone. */
	date: string;
	totalTokens: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	/** Estimated USD cost reported by Pi for entries with usage metadata. */
	cost: number;
	/** Tokens per opaque usageModelKey; unattributed tokens remain in totalTokens. */
	byModel: Record<string, number>;
}

export interface UsageHeatmapCell {
	date: string;
	totalTokens: number;
	/** True when at least one completed assistant reply landed that day, including zero-token replies. */
	active: boolean;
}

export interface UsageStatsSnapshot {
	rangeDays: UsageRangeDays;
	/** Files omitted because they were malformed or unreadable during this scan. */
	skippedFileCount: number;
	/** Totals inside rangeDays, while heatmap and paletteOrder use the longer 53-week window. */
	totalTokens: number;
	sessionCount: number;
	userMessageCount: number;
	activeDays: number;
	/** Consecutive active days ending today; zero when today is inactive. */
	currentStreak: number;
	models: UsageModelStat[];
	days: UsageDayStat[];
	heatmap: UsageHeatmapCell[];
	paletteOrder: string[];
}

export type ProviderQuotaWindowKind = "rolling" | "weekly" | "model" | "premium" | "chat" | "other";

export interface ProviderQuotaWindow {
	id: string;
	kind: ProviderQuotaWindowKind;
	/** Provider-supplied name for model-specific or otherwise non-standard windows. */
	label: string | null;
	usedPercent: number | null;
	used: number | null;
	limit: number | null;
	remaining: number | null;
	unit: string | null;
	durationSeconds: number | null;
	resetAt: number | null;
	unlimited: boolean;
}

type ProviderQuotaAmountKind = "balance" | "remaining" | "spend";
type ProviderQuotaAmountPeriod = "day" | "week" | "month" | "total" | null;

export interface ProviderQuotaAmount {
	kind: ProviderQuotaAmountKind;
	period: ProviderQuotaAmountPeriod;
	value: number;
	limit: number | null;
	unit: string;
}

export type ProviderQuotaErrorCode =
	"authentication" | "rate-limit" | "timeout" | "network" | "service" | "invalid-response";
type ProviderQuotaStatus = "available" | "unsupported" | "error";

export interface ProviderQuota {
	id: string;
	name: string;
	status: ProviderQuotaStatus;
	plan: string | null;
	windows: ProviderQuotaWindow[];
	amounts: ProviderQuotaAmount[];
	error: ProviderQuotaErrorCode | null;
}

/** Quotas exposed by configured Pi providers through their own read-only account APIs. */
export interface ProviderQuotaSnapshot {
	generatedAt: number;
	providers: ProviderQuota[];
}
