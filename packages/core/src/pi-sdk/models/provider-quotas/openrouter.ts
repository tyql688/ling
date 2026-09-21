import {
	type QuotaRuntime,
	finiteNumberSchema,
	nonnegativeNumberSchema,
	parsePayload,
	requestJson,
	resolveProviderToken,
	textSchema,
	type ProviderQuotaData,
} from "./shared";
import type { ProviderQuotaAmount } from "@ling/contracts/usage";
import { z } from "zod";

const openRouterUsageSchema = z.object({
	data: z.object({
		is_free_tier: z.boolean().optional(),
		limit: finiteNumberSchema.nullish(),
		limit_remaining: finiteNumberSchema.nullish(),
		limit_reset: textSchema.nullish(),
		usage: nonnegativeNumberSchema.nullish(),
		usage_daily: nonnegativeNumberSchema.nullish(),
		usage_weekly: nonnegativeNumberSchema.nullish(),
		usage_monthly: nonnegativeNumberSchema.nullish(),
	}),
});

function openRouterPeriod(value: string | null | undefined): ProviderQuotaAmount["period"] {
	switch (value?.toLowerCase()) {
		case "daily":
			return "day";
		case "weekly":
			return "week";
		case "monthly":
			return "month";
		default:
			return null;
	}
}

export async function fetchOpenRouterQuota(runtime: QuotaRuntime, signal: AbortSignal): Promise<ProviderQuotaData> {
	const token = await resolveProviderToken(runtime, "openrouter", signal);
	return parseOpenRouterQuota(
		await requestJson(
			"https://openrouter.ai/api/v1/key",
			{ Accept: "application/json", Authorization: `Bearer ${token}` },
			signal,
		),
	);
}

export function parseOpenRouterQuota(value: unknown): ProviderQuotaData {
	const { data } = parsePayload(openRouterUsageSchema, value);
	const amounts: ProviderQuotaAmount[] = [];
	const limitPeriod = openRouterPeriod(data.limit_reset);
	const limit = data.limit !== null && data.limit !== undefined && data.limit > 0 ? data.limit : null;
	if (limit !== null && data.limit_remaining !== null && data.limit_remaining !== undefined) {
		amounts.push({
			kind: "remaining",
			period: limitPeriod,
			value: data.limit_remaining,
			limit,
			unit: "USD",
		});
	}
	for (const [value, period] of [
		[data.usage_daily, "day"],
		[data.usage_weekly, "week"],
		[data.usage_monthly, "month"],
	] as const) {
		if (value === null || value === undefined) continue;
		amounts.push({
			kind: "spend",
			period,
			value,
			limit: limitPeriod === period ? limit : null,
			unit: "USD",
		});
	}
	if (!amounts.some((amount) => amount.kind === "spend") && data.usage !== null && data.usage !== undefined) {
		amounts.push({ kind: "spend", period: "total", value: data.usage, limit, unit: "USD" });
	}
	return { plan: data.is_free_tier === true ? "free" : null, windows: [], amounts };
}
