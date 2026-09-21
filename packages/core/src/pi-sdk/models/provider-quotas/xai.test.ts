import { describe, expect, it } from "vitest";
import { parseXaiQuota } from "./xai";
import { ProviderQuotaReadError } from "./shared";

describe("xAI usage payload", () => {
	it("derives overage from credits without inventing currency", () => {
		const quota = parseXaiQuota({
			config: {
				onDemandUsed: { val: 12 },
				onDemandCap: { val: 10 },
				subscriptionTier: "cli",
				currentPeriod: { end: "2027-01-01T00:00:00Z" },
			},
		});
		expect(quota).toMatchObject({
			plan: "cli",
			amounts: [],
			windows: [{ usedPercent: 120, resetAt: Date.parse("2027-01-01T00:00:00Z"), unit: null }],
		});
	});
	it("prefers the reported percentage and rejects an empty billing result", () => {
		expect(
			parseXaiQuota({ config: { creditUsagePercent: 20, onDemandUsed: { val: 12 }, onDemandCap: { val: 10 } } })
				.windows,
		).toMatchObject([{ usedPercent: 20 }]);
		expect(() => parseXaiQuota({ config: {} })).toThrow(ProviderQuotaReadError);
	});
});
