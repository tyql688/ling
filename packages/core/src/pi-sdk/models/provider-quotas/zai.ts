import {
	type QuotaRuntime,
	emptyWindow,
	epochMilliseconds,
	finiteNumberSchema,
	firstBoundedText,
	parsePayload,
	PROVIDER_QUOTA_WINDOW_MAX_ITEMS,
	ProviderQuotaReadError,
	requestJson,
	resolveProviderToken,
	SECONDS_PER_DAY,
	SECONDS_PER_HOUR,
	SECONDS_PER_MINUTE,
	SECONDS_PER_WEEK,
	textSchema,
	type ProviderQuotaData,
} from "./shared";
import type { ProviderQuotaWindow, ProviderQuotaWindowKind } from "@ling/contracts/usage";
import { z } from "zod";

/** Z.AI uses a one-minute-shaped TIME_LIMIT as its monthly MCP quota sentinel. */
const ZAI_MONTHLY_MCP_DAYS = 30;

const zaiLimitSchema = z.object({
	type: textSchema,
	unit: z.number().int(),
	number: z.number().int(),
	percentage: finiteNumberSchema,
	usage: z.number().int().nonnegative().nullish(),
	currentValue: z.number().int().nonnegative().nullish(),
	remaining: z.number().int().nonnegative().nullish(),
	nextResetTime: z.number().int().nonnegative().nullish(),
	usageDetails: z.array(z.unknown()).max(PROVIDER_QUOTA_WINDOW_MAX_ITEMS).nullish(),
});
const zaiUsageSchema = z.object({
	code: z.number().int(),
	msg: textSchema.nullish(),
	success: z.boolean(),
	data: z.object({
		limits: z.array(zaiLimitSchema).max(PROVIDER_QUOTA_WINDOW_MAX_ITEMS),
		planName: textSchema.nullish(),
		plan: textSchema.nullish(),
		plan_type: textSchema.nullish(),
		packageName: textSchema.nullish(),
		level: textSchema.nullish(),
	}),
});

type ZaiLimit = z.infer<typeof zaiLimitSchema>;

function zaiDurationSeconds(limit: ZaiLimit): number | null {
	if (limit.number <= 0) return null;
	if (limit.type === "TIME_LIMIT" && limit.unit === 5 && limit.number === 1) {
		return ZAI_MONTHLY_MCP_DAYS * SECONDS_PER_DAY;
	}
	const multiplier =
		limit.unit === 1
			? SECONDS_PER_DAY
			: limit.unit === 3
				? SECONDS_PER_HOUR
				: limit.unit === 5
					? SECONDS_PER_MINUTE
					: limit.unit === 6
						? SECONDS_PER_WEEK
						: null;
	return multiplier === null ? null : limit.number * multiplier;
}

function zaiWindow(limit: ZaiLimit, index: number): ProviderQuotaWindow | null {
	if (limit.type !== "TOKENS_LIMIT" && limit.type !== "CREDIT_LIMIT" && limit.type !== "TIME_LIMIT") return null;
	const countLimit = limit.usage !== null && limit.usage !== undefined && limit.usage > 0 ? limit.usage : null;
	const derivedUsed =
		countLimit === null
			? null
			: limit.currentValue !== null && limit.currentValue !== undefined
				? Math.max(0, limit.currentValue)
				: limit.remaining !== null && limit.remaining !== undefined
					? Math.max(0, countLimit - limit.remaining)
					: null;
	const usedPercent =
		countLimit !== null && derivedUsed !== null ? (derivedUsed / countLimit) * 100 : Math.max(0, limit.percentage);
	const durationSeconds = zaiDurationSeconds(limit);
	const kind: ProviderQuotaWindowKind = limit.type === "TIME_LIMIT" ? "other" : limit.unit === 6 ? "weekly" : "rolling";
	return emptyWindow(`zai-${index + 1}`, kind, {
		label: limit.type === "TIME_LIMIT" ? "MCP" : limit.type === "CREDIT_LIMIT" ? "Credit quota" : "Token quota",
		usedPercent,
		used: derivedUsed,
		limit: countLimit,
		remaining: limit.remaining ?? (countLimit !== null && derivedUsed !== null ? countLimit - derivedUsed : null),
		unit:
			countLimit === null
				? null
				: limit.type === "CREDIT_LIMIT"
					? "credits"
					: limit.type === "TOKENS_LIMIT"
						? "tokens"
						: "uses",
		durationSeconds,
		resetAt: epochMilliseconds(limit.nextResetTime),
	});
}

export async function fetchZaiQuota(
	runtime: QuotaRuntime,
	providerId: "zai" | "zai-coding-cn",
	signal: AbortSignal,
): Promise<ProviderQuotaData> {
	const token = await resolveProviderToken(runtime, providerId, signal);
	const host = providerId === "zai" ? "https://api.z.ai" : "https://open.bigmodel.cn";
	return parseZaiQuota(
		await requestJson(
			`${host}/api/monitor/usage/quota/limit`,
			{ Accept: "application/json", Authorization: `Bearer ${token}` },
			signal,
		),
	);
}

export function parseZaiQuota(value: unknown): ProviderQuotaData {
	const payload = parsePayload(zaiUsageSchema, value);
	if (!payload.success || payload.code !== 200) throw new ProviderQuotaReadError("service");
	return {
		plan: firstBoundedText(
			payload.data.planName,
			payload.data.plan,
			payload.data.plan_type,
			payload.data.packageName,
			payload.data.level,
		),
		windows: payload.data.limits.map(zaiWindow).filter((window): window is ProviderQuotaWindow => window !== null),
		amounts: [],
	};
}
