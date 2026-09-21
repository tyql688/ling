import { describe, expect, it } from "vitest";
import { parseCodexQuota } from "./openai-codex";
import { ProviderQuotaReadError } from "./shared";

describe("Codex usage payload", () => {
	it("preserves missing account windows and keeps unnamed additional limits separate", () => {
		const quota = parseCodexQuota({
			plan_type: "pro",
			rate_limit: { primary_window: null, secondary_window: { used_percent: 14, limit_window_seconds: 604800 } },
			additional_rate_limits: [{ rate_limit: { primary_window: { used_percent: 0, limit_window_seconds: 18000 } } }],
		});
		expect(quota.windows).toMatchObject([
			{ id: "codex:secondary", kind: "rolling", durationSeconds: 604800 },
			{ id: "additional-1:primary", kind: "model", label: null, durationSeconds: 18000 },
		]);
	});
	it("converts second resets and preserves overage and feature windows", () => {
		const quota = parseCodexQuota({
			plan_type: "pro",
			rate_limit: { primary_window: { used_percent: 125, reset_at: 1_800_000_000, limit_window_seconds: 18000 } },
			additional_rate_limits: [
				{
					metered_feature: "review",
					limit_name: "Code review",
					rate_limit: { secondary_window: { used_percent: 12, reset_at: 1_800_000_000_000 } },
				},
			],
			credits: { has_credits: true, balance: "5.25" },
		});
		expect(quota.windows).toMatchObject([
			{ id: "codex:primary", usedPercent: 125, resetAt: 1_800_000_000_000, durationSeconds: 18000 },
			{ id: "review:secondary", kind: "model", label: "Code review", resetAt: 1_800_000_000_000 },
		]);
		expect(quota.amounts).toMatchObject([{ value: 5.25, unit: "credits", limit: null }]);
	});
	it("does not show a finite balance for unlimited or unavailable credits", () => {
		for (const credits of [
			{ unlimited: true, balance: "99" },
			{ has_credits: false, balance: "99" },
		])
			expect(parseCodexQuota({ credits }).amounts).toEqual([]);
	});
	it("rejects malformed usage windows", () => {
		expect(() => parseCodexQuota({ rate_limit: { primary_window: { used_percent: "unknown" } } })).toThrow(
			ProviderQuotaReadError,
		);
	});
});
