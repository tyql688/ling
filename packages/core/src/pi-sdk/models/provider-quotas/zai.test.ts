import { describe, expect, it } from "vitest";
import { parseZaiQuota } from "./zai";
import { ProviderQuotaReadError } from "./shared";

describe("Z.AI usage payload", () => {
	it("uses actual counts and recognizes the monthly MCP sentinel", () => {
		const quota = parseZaiQuota({
			code: 200,
			success: true,
			data: {
				planName: "Pro",
				limits: [
					{
						type: "TOKENS_LIMIT",
						unit: 3,
						number: 5,
						percentage: 10,
						usage: 100,
						currentValue: 120,
						nextResetTime: 1_800_000_000,
					},
					{ type: "TIME_LIMIT", unit: 5, number: 1, percentage: 40 },
					{ type: "future", unit: 1, number: 1, percentage: 50 },
				],
			},
		});
		expect(quota.windows).toMatchObject([
			{ usedPercent: 120, remaining: -20, durationSeconds: 18000, resetAt: 1_800_000_000_000 },
			{ label: "MCP", durationSeconds: 2592000 },
		]);
	});
	it("distinguishes service rejection from invalid payloads", () => {
		expect(() => parseZaiQuota({ code: 500, success: false, data: { limits: [] } })).toThrow(
			expect.objectContaining({ code: "service" }),
		);
		expect(() => parseZaiQuota({ code: 200, success: true, data: { limits: "bad" } })).toThrow(ProviderQuotaReadError);
	});
});
