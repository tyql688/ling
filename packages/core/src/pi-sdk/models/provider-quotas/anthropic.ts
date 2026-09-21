import {
	type QuotaRuntime,
	currencyCode,
	dateSchema,
	emptyWindow,
	epochMilliseconds,
	MINOR_UNITS_PER_CURRENCY_UNIT,
	nonnegativeNumberSchema,
	parsePayload,
	PROVIDER_QUOTA_WINDOW_MAX_ITEMS,
	requestJson,
	resolveProviderToken,
	SECONDS_PER_HOUR,
	SECONDS_PER_WEEK,
	textSchema,
	type ProviderQuotaData,
	type ProviderQuotaCache,
} from "./shared";
import type { ProviderQuotaAmount, ProviderQuotaWindow, ProviderQuotaWindowKind } from "@ling/contracts/usage";
import { z } from "zod";

/** Anthropic aggressively rate-limits its OAuth usage endpoint, so successful reads are reused for five minutes. */
const ANTHROPIC_QUOTA_CACHE_MS = 5 * 60_000;
/** Failed Anthropic reads get a short backoff while still allowing timely recovery. */
const ANTHROPIC_QUOTA_ERROR_CACHE_MS = 30_000;

const claudeWindowSchema = z.object({
	utilization: nonnegativeNumberSchema.nullish(),
	resets_at: dateSchema.nullish(),
});
const claudeUsageSchema = z.object({
	five_hour: claudeWindowSchema.nullish(),
	seven_day: claudeWindowSchema.nullish(),
	seven_day_oauth_apps: claudeWindowSchema.nullish(),
	seven_day_opus: claudeWindowSchema.nullish(),
	seven_day_sonnet: claudeWindowSchema.nullish(),
	limits: z
		.array(
			z.object({
				kind: textSchema.nullish(),
				group: textSchema.nullish(),
				percent: nonnegativeNumberSchema.nullish(),
				resets_at: dateSchema.nullish(),
				is_active: z.boolean().nullish(),
				scope: z
					.object({
						model: z.object({ id: textSchema.nullish(), display_name: textSchema.nullish() }).nullish(),
					})
					.nullish(),
			}),
		)
		.max(PROVIDER_QUOTA_WINDOW_MAX_ITEMS)
		.nullish(),
	extra_usage: z
		.object({
			is_enabled: z.boolean().nullish(),
			monthly_limit: nonnegativeNumberSchema.nullish(),
			used_credits: nonnegativeNumberSchema.nullish(),
			currency: textSchema.nullish(),
		})
		.nullish(),
});

function claudeWindow(
	id: string,
	kind: ProviderQuotaWindowKind,
	window: z.infer<typeof claudeWindowSchema> | null | undefined,
	durationSeconds: number,
	label: string | null = null,
): ProviderQuotaWindow | null {
	if (!window || ((window.utilization === null || window.utilization === undefined) && !window.resets_at)) return null;
	return emptyWindow(id, kind, {
		label,
		usedPercent: window.utilization ?? null,
		durationSeconds,
		resetAt: epochMilliseconds(window.resets_at),
	});
}

async function readClaudeQuota(token: string, signal: AbortSignal): Promise<ProviderQuotaData> {
	return parseClaudeQuota(
		await requestJson(
			"https://api.anthropic.com/api/oauth/usage",
			{
				Accept: "application/json",
				Authorization: `Bearer ${token}`,
				"anthropic-beta": "oauth-2025-04-20",
				"User-Agent": "pi",
			},
			signal,
		),
	);
}

export function parseClaudeQuota(value: unknown): ProviderQuotaData {
	const payload = parsePayload(claudeUsageSchema, value);
	const windows = [
		claudeWindow("five-hour", "rolling", payload.five_hour, 5 * SECONDS_PER_HOUR),
		claudeWindow("seven-day", "weekly", payload.seven_day, SECONDS_PER_WEEK),
		claudeWindow("oauth-apps", "weekly", payload.seven_day_oauth_apps, SECONDS_PER_WEEK, "OAuth apps"),
	].filter((window): window is ProviderQuotaWindow => window !== null);
	if (payload.limits && payload.limits.length > 0) {
		for (const [index, limit] of payload.limits.entries()) {
			if (limit.is_active === false || ((limit.percent === null || limit.percent === undefined) && !limit.resets_at))
				continue;
			const model = limit.scope?.model;
			const label = model?.display_name ?? model?.id ?? null;
			if (!label) continue;
			windows.push(
				emptyWindow(`model-${index + 1}`, "model", {
					label,
					usedPercent: limit.percent ?? null,
					durationSeconds: limit.group === "weekly" ? SECONDS_PER_WEEK : null,
					resetAt: epochMilliseconds(limit.resets_at),
				}),
			);
		}
	} else {
		for (const [id, label, value] of [
			["opus", "Opus", payload.seven_day_opus],
			["sonnet", "Sonnet", payload.seven_day_sonnet],
		] as const) {
			const window = claudeWindow(id, "model", value, SECONDS_PER_WEEK, label);
			if (window) windows.push(window);
		}
	}

	const extra = payload.extra_usage;
	const currency = currencyCode(extra?.currency);
	const amounts: ProviderQuotaAmount[] = [];
	if (extra?.is_enabled === true && currency && extra.used_credits !== null && extra.used_credits !== undefined) {
		amounts.push({
			kind: "spend",
			period: "month",
			value: extra.used_credits / MINOR_UNITS_PER_CURRENCY_UNIT,
			limit:
				extra.monthly_limit === null || extra.monthly_limit === undefined
					? null
					: extra.monthly_limit / MINOR_UNITS_PER_CURRENCY_UNIT,
			unit: currency,
		});
	}
	return { plan: null, windows, amounts };
}

export async function fetchClaudeQuota(
	runtime: QuotaRuntime,
	signal: AbortSignal,
	cache: ProviderQuotaCache,
): Promise<ProviderQuotaData> {
	const token = await resolveProviderToken(runtime, "anthropic", signal);
	return cache.read(
		"anthropic",
		token,
		{
			successMs: ANTHROPIC_QUOTA_CACHE_MS,
			failureMs: ANTHROPIC_QUOTA_ERROR_CACHE_MS,
			rateLimitMs: ANTHROPIC_QUOTA_CACHE_MS,
		},
		signal,
		(signal) => readClaudeQuota(token, signal),
	);
}
