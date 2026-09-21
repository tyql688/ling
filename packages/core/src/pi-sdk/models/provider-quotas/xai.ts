import {
	type QuotaRuntime,
	dateSchema,
	emptyWindow,
	epochMilliseconds,
	finiteNumberSchema,
	parsePayload,
	ProviderQuotaReadError,
	requestJson,
	resolveProviderToken,
	textSchema,
	type ProviderQuotaData,
} from "./shared";
import { z } from "zod";

const xaiAmountSchema = z.object({ val: finiteNumberSchema.nullish() });
const xaiBillingSchema = z.object({
	config: z.object({
		creditUsagePercent: finiteNumberSchema.nullish(),
		currentPeriod: z.object({ end: dateSchema.nullish() }).nullish(),
		billingPeriodEnd: dateSchema.nullish(),
		onDemandCap: xaiAmountSchema.nullish(),
		onDemandUsed: xaiAmountSchema.nullish(),
		subscriptionTier: textSchema.nullish(),
	}),
	subscriptionTier: textSchema.nullish(),
});

export async function fetchXaiQuota(runtime: QuotaRuntime, signal: AbortSignal): Promise<ProviderQuotaData> {
	const token = await resolveProviderToken(runtime, "xai", signal);
	return parseXaiQuota(
		await requestJson(
			"https://cli-chat-proxy.grok.com/v1/billing?format=credits",
			{
				Accept: "application/json",
				Authorization: `Bearer ${token}`,
				"User-Agent": "pi",
				"x-xai-token-auth": "xai-grok-cli",
			},
			signal,
		),
	);
}

export function parseXaiQuota(value: unknown): ProviderQuotaData {
	const payload = parsePayload(xaiBillingSchema, value);
	const resetAt = epochMilliseconds(payload.config.currentPeriod?.end ?? payload.config.billingPeriodEnd);
	const cap = payload.config.onDemandCap?.val;
	const used = payload.config.onDemandUsed?.val;
	const sourcePercent = payload.config.creditUsagePercent;
	const usedPercent =
		sourcePercent !== null && sourcePercent !== undefined
			? Math.max(0, sourcePercent)
			: cap !== null && cap !== undefined && cap > 0 && used !== null && used !== undefined
				? Math.max(0, (used / cap) * 100)
				: null;
	if (usedPercent === null && resetAt === null) throw new ProviderQuotaReadError("invalid-response");
	return {
		plan: payload.config.subscriptionTier ?? payload.subscriptionTier ?? null,
		windows: [
			emptyWindow("credits", "other", {
				label: "Credits",
				usedPercent,
				resetAt,
			}),
		],
		amounts: [],
	};
}
