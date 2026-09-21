import { describe, expect, it } from "vitest";
import { parseCopilotQuota } from "./github-copilot";
import { ProviderQuotaReadError } from "./shared";

describe("Copilot account payload", () => {
	it("preserves unlimited chat and premium overage while omitting disabled zero buckets", () => {
		const quota = parseCopilotQuota({
			copilot_plan: "pro",
			quota_reset_date: "2027-01-01T00:00:00Z",
			quota_snapshots: {
				chat: { unlimited: true },
				premium_interactions: { entitlement: "100", remaining: "0", percent_remaining: "-10", credits_used: "2" },
				completions: { entitlement: 0, remaining: 0 },
			},
		});
		expect(quota.windows).toMatchObject([
			{ kind: "chat", unlimited: true, usedPercent: null },
			{ kind: "premium", usedPercent: 110, used: 100, resetAt: Date.parse("2027-01-01T00:00:00Z") },
		]);
		expect(quota.amounts).toMatchObject([{ kind: "spend", value: 2, unit: "credits" }]);
	});
	it("rejects malformed counts", () => {
		expect(() => parseCopilotQuota({ quota_snapshots: { chat: { entitlement: "unknown" } } })).toThrow(
			ProviderQuotaReadError,
		);
	});
});
