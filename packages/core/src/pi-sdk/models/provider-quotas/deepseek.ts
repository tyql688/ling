import {
	type QuotaRuntime,
	currencyCode,
	flexibleNumberSchema,
	parsePayload,
	PROVIDER_QUOTA_WINDOW_MAX_ITEMS,
	requestJson,
	resolveProviderToken,
	textSchema,
	type ProviderQuotaData,
} from "./shared";
import type { ProviderQuotaAmount } from "@ling/contracts/usage";
import { z } from "zod";

const deepSeekBalanceSchema = z.object({
	is_available: z.boolean(),
	balance_infos: z
		.array(
			z.object({
				currency: textSchema,
				total_balance: flexibleNumberSchema,
				granted_balance: flexibleNumberSchema,
				topped_up_balance: flexibleNumberSchema,
			}),
		)
		.max(PROVIDER_QUOTA_WINDOW_MAX_ITEMS),
});

export async function fetchDeepSeekQuota(runtime: QuotaRuntime, signal: AbortSignal): Promise<ProviderQuotaData> {
	const token = await resolveProviderToken(runtime, "deepseek", signal);
	return parseDeepSeekQuota(
		await requestJson(
			"https://api.deepseek.com/user/balance",
			{ Accept: "application/json", Authorization: `Bearer ${token}` },
			signal,
		),
	);
}

export function parseDeepSeekQuota(value: unknown): ProviderQuotaData {
	const payload = parsePayload(deepSeekBalanceSchema, value);
	const currencies = new Set<string>();
	const amounts: ProviderQuotaAmount[] = [];
	for (const balance of payload.balance_infos) {
		const currency = currencyCode(balance.currency);
		if (!currency || currencies.has(currency)) continue;
		currencies.add(currency);
		amounts.push({ kind: "balance", period: null, value: balance.total_balance, limit: null, unit: currency });
	}
	return { plan: null, windows: [], amounts };
}
