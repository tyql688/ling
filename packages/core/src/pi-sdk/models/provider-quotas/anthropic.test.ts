import { describe, expect, it } from "vitest";
import { parseClaudeQuota } from "./anthropic";
import { ProviderQuotaReadError } from "./shared";

describe("Anthropic usage payload", () => {
	it("keeps active model limits, reset timestamps and explicit currency amounts", () => {
		const quota = parseClaudeQuota({
			five_hour: { utilization: 120, resets_at: "2027-01-01T00:00:00Z" },
			seven_day_opus: { utilization: 99 },
			limits: [
				{ percent: 10, group: "weekly", scope: { model: { display_name: "Opus" } } },
				{ percent: 40, is_active: false, scope: { model: { display_name: "Old" } } },
			],
			extra_usage: { is_enabled: true, used_credits: 125, monthly_limit: 500, currency: "USD" },
		});
		expect(quota.windows).toMatchObject([
			{ id: "five-hour", usedPercent: 120, resetAt: Date.parse("2027-01-01T00:00:00Z"), durationSeconds: 18000 },
			{ kind: "model", label: "Opus", usedPercent: 10, durationSeconds: 604800 },
		]);
		expect(quota.amounts).toEqual([{ kind: "spend", period: "month", value: 1.25, limit: 5, unit: "USD" }]);
	});
	it("uses legacy model fields only when detailed limits are absent, and requires a currency", () => {
		const quota = parseClaudeQuota({
			seven_day_sonnet: { utilization: 12 },
			extra_usage: { is_enabled: true, used_credits: 100 },
		});
		expect(quota.windows).toMatchObject([{ label: "Sonnet", usedPercent: 12 }]);
		expect(quota.amounts).toEqual([]);
	});
	it("rejects invalid percentages", () => {
		expect(() => parseClaudeQuota({ five_hour: { utilization: -1 } })).toThrow(ProviderQuotaReadError);
	});
});
