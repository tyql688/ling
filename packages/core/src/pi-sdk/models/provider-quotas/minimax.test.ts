import { afterEach, describe, expect, it, vi } from "vitest";
import { parseMiniMaxQuota } from "./minimax";
import { ProviderQuotaReadError } from "./shared";

afterEach(() => vi.useRealTimers());
describe("MiniMax usage payload", () => {
	it("treats usage_count as remaining and converts relative reset seconds", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2027-01-01T00:00:00Z"));
		const quota = parseMiniMaxQuota({
			data: {
				plan_name: "Coding",
				model_remains: [
					{
						model_name: "general",
						current_interval_total_count: "100",
						current_interval_usage_count: "25",
						remains_time: 60,
						current_weekly_status: 3,
						current_weekly_remaining_percent: 100,
					},
				],
			},
		});
		expect(quota.windows).toMatchObject([
			{ usedPercent: 75, used: 75, remaining: 25, resetAt: Date.now() + 60000 },
			{ unlimited: true, usedPercent: null, resetAt: null },
		]);
	});
	it("converts millisecond countdowns without creating weekly image quotas", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2027-01-01T00:00:00Z"));
		expect(
			parseMiniMaxQuota({
				model_remains: [
					{
						model_name: "image",
						current_interval_remaining_percent: -10,
						remains_time: 2_000_000,
						current_weekly_remaining_percent: 10,
					},
				],
			}).windows,
		).toMatchObject([{ usedPercent: 110, resetAt: Date.now() + 2_000_000 }]);
	});
	it("distinguishes malformed, authentication and service failures", () => {
		expect(() => parseMiniMaxQuota({})).toThrow(ProviderQuotaReadError);
		expect(() => parseMiniMaxQuota({ base_resp: { status_code: 1004 } })).toThrow(
			expect.objectContaining({ code: "authentication" }),
		);
		expect(() => parseMiniMaxQuota({ base_resp: { status_code: 500 } })).toThrow(
			expect.objectContaining({ code: "service" }),
		);
	});
});
