import { describe, expect, it } from "vitest";
import { parseKimiQuota } from "./kimi";
import { ProviderQuotaReadError } from "./shared";

describe("Kimi usage payload", () => {
	it("normalizes rolling duration, remaining counts and second resets", () => {
		const quota = parseKimiQuota({
			user: { membership: { level: "adagio" } },
			usage: { limit: "100", remaining: "70" },
			limits: [{ window: { duration: 5, timeUnit: "HOUR" }, detail: { limit: 10, used: 12, reset_at: 1_800_000_000 } }],
		});
		expect(quota.plan).toBe("adagio");
		expect(quota.windows).toMatchObject([
			{ usedPercent: 30, used: 30, remaining: 70 },
			{ usedPercent: 120, remaining: -2, durationSeconds: 18000, resetAt: 1_800_000_000_000 },
		]);
	});
	it("converts fixed point wallet cents and keeps a small positive balance visible", () => {
		const quota = parseKimiQuota({
			boosterWallet: {
				balance: { type: "BOOSTER", amountLeft: "1" },
				monthlyUsed: { priceInCents: "125", currency: "CNY" },
				monthlyChargeLimit: { priceInCents: 500, currency: "CNY" },
				monthlyChargeLimitEnabled: true,
			},
		});
		expect(quota.amounts).toEqual([
			{ kind: "spend", period: "month", value: 1.25, limit: 5, unit: "CNY" },
			{ kind: "balance", period: null, value: 0.01, limit: null, unit: "CNY" },
		]);
	});
	it("does not infer currency or numbers from malformed nested fields", () => {
		expect(
			parseKimiQuota({
				usage: { used: "bad" },
				boosterWallet: { balance: { type: "BOOSTER", amountLeft: "1000000" } },
			}),
		).toMatchObject({ windows: [], amounts: [] });
		expect(() => parseKimiQuota({ limits: "bad" })).toThrow(ProviderQuotaReadError);
	});
});
