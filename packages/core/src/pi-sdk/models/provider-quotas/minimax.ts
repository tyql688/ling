import {
	type QuotaRuntime,
	emptyWindow,
	epochMilliseconds,
	firstBoundedText,
	flexibleNonnegativeIntegerSchema,
	flexibleNonnegativeNumberSchema,
	flexibleNumberSchema,
	MILLISECONDS_PER_SECOND,
	parsePayload,
	PROVIDER_QUOTA_WINDOW_MAX_ITEMS,
	ProviderQuotaReadError,
	quotaErrorCode,
	requestJson,
	resolveProviderToken,
	SECONDS_PER_WEEK,
	textSchema,
	type ProviderQuotaData,
} from "./shared";
import type { ProviderQuotaWindow } from "@ling/contracts/usage";
import { throwIfOperationAborted, toError } from "@ling/core/ling-error";
import { z } from "zod";

/** MiniMax switches `remains_time` from seconds to milliseconds above this vendor-defined range. */
const MINIMAX_REMAINS_MILLISECONDS_THRESHOLD = 1_000_000;

const miniMaxBaseResponseSchema = z.object({
	status_code: flexibleNonnegativeIntegerSchema.nullish(),
	status_msg: textSchema.nullish(),
});
const miniMaxModelRemainsSchema = z.object({
	model_name: textSchema,
	current_interval_total_count: flexibleNonnegativeIntegerSchema.nullish(),
	current_interval_usage_count: flexibleNonnegativeIntegerSchema.nullish(),
	current_interval_remaining_percent: flexibleNumberSchema.nullish(),
	current_interval_status: flexibleNonnegativeIntegerSchema.nullish(),
	start_time: flexibleNonnegativeNumberSchema.nullish(),
	end_time: flexibleNonnegativeNumberSchema.nullish(),
	remains_time: flexibleNonnegativeNumberSchema.nullish(),
	current_weekly_total_count: flexibleNonnegativeIntegerSchema.nullish(),
	current_weekly_usage_count: flexibleNonnegativeIntegerSchema.nullish(),
	current_weekly_remaining_percent: flexibleNumberSchema.nullish(),
	current_weekly_status: flexibleNonnegativeIntegerSchema.nullish(),
	weekly_start_time: flexibleNonnegativeNumberSchema.nullish(),
	weekly_end_time: flexibleNonnegativeNumberSchema.nullish(),
	weekly_remains_time: flexibleNonnegativeNumberSchema.nullish(),
});
const miniMaxQuotaDataSchema = z.object({
	base_resp: miniMaxBaseResponseSchema.nullish(),
	model_remains: z.array(miniMaxModelRemainsSchema).max(PROVIDER_QUOTA_WINDOW_MAX_ITEMS).nullish(),
	current_subscribe_title: textSchema.nullish(),
	plan_name: textSchema.nullish(),
	combo_title: textSchema.nullish(),
	current_plan_title: textSchema.nullish(),
	points_balance: flexibleNonnegativeNumberSchema.nullish(),
});
const miniMaxUsageSchema = miniMaxQuotaDataSchema.extend({ data: miniMaxQuotaDataSchema.nullish() });

type MiniMaxModelRemains = z.infer<typeof miniMaxModelRemainsSchema>;

function miniMaxIsTextModel(modelName: string): boolean {
	const normalized = modelName.trim().toLowerCase();
	return normalized === "general" || normalized.includes("minimax-m") || normalized.startsWith("m2.");
}

function miniMaxResetAt(
	end: number | null | undefined,
	remains: number | null | undefined,
	now: number,
): number | null {
	const endAt = epochMilliseconds(end);
	if (endAt !== null && endAt > now) return endAt;
	if (!remains || remains <= 0) return null;
	const milliseconds = remains > MINIMAX_REMAINS_MILLISECONDS_THRESHOLD ? remains : remains * MILLISECONDS_PER_SECOND;
	const resetAt = Math.round(now + milliseconds);
	return Number.isSafeInteger(resetAt) ? resetAt : null;
}

function miniMaxDuration(start: number | null | undefined, end: number | null | undefined): number | null {
	const startAt = epochMilliseconds(start);
	const endAt = epochMilliseconds(end);
	if (startAt === null || endAt === null || endAt <= startAt) return null;
	return (endAt - startAt) / MILLISECONDS_PER_SECOND;
}

function miniMaxWindow(
	item: MiniMaxModelRemains,
	index: number,
	weekly: boolean,
	now: number,
): ProviderQuotaWindow | null {
	const textModel = miniMaxIsTextModel(item.model_name);
	if (weekly && !textModel) return null;
	const total = weekly ? item.current_weekly_total_count : item.current_interval_total_count;
	const remaining = weekly ? item.current_weekly_usage_count : item.current_interval_usage_count;
	const remainingPercent = weekly ? item.current_weekly_remaining_percent : item.current_interval_remaining_percent;
	const status = weekly ? item.current_weekly_status : item.current_interval_status;
	const unlimited =
		weekly &&
		textModel &&
		status === 3 &&
		remainingPercent !== null &&
		remainingPercent !== undefined &&
		remainingPercent >= 100;
	if (
		!weekly &&
		status === 3 &&
		(total ?? 0) === 0 &&
		(remaining ?? 0) === 0 &&
		remainingPercent !== null &&
		remainingPercent !== undefined &&
		remainingPercent >= 100
	) {
		return null;
	}
	const hasCounts =
		(remainingPercent === null || remainingPercent === undefined) &&
		total !== null &&
		total !== undefined &&
		total > 0 &&
		remaining !== null &&
		remaining !== undefined;
	const used = hasCounts ? Math.max(0, total - remaining) : null;
	const usedPercent = unlimited
		? null
		: remainingPercent !== null && remainingPercent !== undefined
			? Math.max(0, 100 - remainingPercent)
			: hasCounts && used !== null
				? (used / total) * 100
				: null;
	if (usedPercent === null && !unlimited) return null;
	const start = weekly ? item.weekly_start_time : item.start_time;
	const end = weekly ? item.weekly_end_time : item.end_time;
	const durationSeconds = miniMaxDuration(start, end) ?? (weekly ? SECONDS_PER_WEEK : null);
	const label = item.model_name.trim().toLowerCase() === "general" ? null : item.model_name;
	return emptyWindow(
		`minimax-${index + 1}-${weekly ? "weekly" : "interval"}`,
		weekly ? "weekly" : label ? "model" : "rolling",
		{
			label,
			usedPercent,
			used,
			limit: hasCounts ? total : null,
			remaining: hasCounts ? remaining : null,
			unit: hasCounts ? "requests" : null,
			durationSeconds,
			resetAt: unlimited ? null : miniMaxResetAt(end, weekly ? item.weekly_remains_time : item.remains_time, now),
			unlimited,
		},
	);
}

export function parseMiniMaxQuota(value: unknown): ProviderQuotaData {
	const payload = parsePayload(miniMaxUsageSchema, value);
	const data = payload.data?.model_remains?.length ? payload.data : payload;
	const response = data.base_resp ?? payload.base_resp;
	if (response?.status_code !== null && response?.status_code !== undefined && response.status_code !== 0) {
		const message = response.status_msg?.toLowerCase() ?? "";
		if (response.status_code === 1001 || response.status_code === 1004 || message.includes("api key")) {
			throw new ProviderQuotaReadError("authentication");
		}
		throw new ProviderQuotaReadError("service");
	}
	const remains = data.model_remains;
	if (!remains?.length) throw new ProviderQuotaReadError("invalid-response");
	const now = Date.now();
	const windows = remains.flatMap((item, index) =>
		[miniMaxWindow(item, index, false, now), miniMaxWindow(item, index, true, now)].filter(
			(window): window is ProviderQuotaWindow => window !== null,
		),
	);
	const points = data.points_balance ?? payload.points_balance;
	return {
		plan: firstBoundedText(
			data.current_subscribe_title,
			data.plan_name,
			data.combo_title,
			data.current_plan_title,
			payload.current_subscribe_title,
			payload.plan_name,
		),
		windows,
		amounts:
			points === null || points === undefined
				? []
				: [{ kind: "balance", period: null, value: points, limit: null, unit: "credits" }],
	};
}

export async function fetchMiniMaxQuota(
	runtime: QuotaRuntime,
	providerId: "minimax" | "minimax-cn",
	signal: AbortSignal,
): Promise<ProviderQuotaData> {
	const token = await resolveProviderToken(runtime, providerId, signal);
	const host = providerId === "minimax" ? "https://api.minimax.io" : "https://api.minimaxi.com";
	let firstError: unknown;
	for (const [index, path] of ["/v1/token_plan/remains", "/v1/api/openplatform/coding_plan/remains"].entries()) {
		try {
			return parseMiniMaxQuota(
				await requestJson(
					`${host}${path}`,
					{
						Accept: "application/json",
						Authorization: `Bearer ${token}`,
						"Content-Type": "application/json",
						"MM-API-Source": "Ling",
					},
					signal,
				),
			);
		} catch (cause) {
			throwIfOperationAborted(signal);
			if (index === 0) {
				firstError = cause;
				continue;
			}
			if (quotaErrorCode(firstError) === "authentication") throw firstError;
			throw cause;
		}
	}
	throw toError(firstError);
}
