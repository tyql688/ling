import { describe, expect, it } from "vitest";
import { parseOpenRouterQuota } from "./openrouter";
import { ProviderQuotaReadError } from "./shared";

describe("OpenRouter usage payload", () => {
	it("retains negative remaining credit and attaches a limit only to its period", () => {
		const quota = parseOpenRouterQuota({
			data: {
				limit: 5,
				limit_remaining: -1,
				limit_reset: "monthly",
				usage_daily: 1,
				usage_weekly: 3,
				usage_monthly: 6,
				usage: 20,
			},
		});
		expect(quota.amounts).toEqual([
			{ kind: "remaining", period: "month", value: -1, limit: 5, unit: "USD" },
			{ kind: "spend", period: "day", value: 1, limit: null, unit: "USD" },
			{ kind: "spend", period: "week", value: 3, limit: null, unit: "USD" },
			{ kind: "spend", period: "month", value: 6, limit: 5, unit: "USD" },
		]);
	});
	it("does not invent a reset window or limit for a free key", () => {
		expect(parseOpenRouterQuota({ data: { is_free_tier: true, limit: 0, usage: 2 } })).toMatchObject({
			plan: "free",
			windows: [],
			amounts: [{ value: 2, period: "total", limit: null }],
		});
	});
	it("rejects missing or malformed data", () => {
		expect(() => parseOpenRouterQuota({})).toThrow(ProviderQuotaReadError);
		expect(() => parseOpenRouterQuota({ data: { usage: "1" } })).toThrow(ProviderQuotaReadError);
	});
});
