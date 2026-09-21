import { describe, expect, it } from "vitest";
import { parseOpenCodeGoQuota } from "./opencode-go";
import { ProviderQuotaReadError } from "./shared";

describe("OpenCode Go usage payload", () => {
	it("prefers the usage plan and preserves unknown monthly duration", () => {
		const quota = parseOpenCodeGoQuota({
			plan: "old",
			usage: {
				plan: "go",
				rolling: { percent: 125, resetsAt: "2027-01-01T00:00:00Z" },
				weekly: { percent: 12 },
				monthly: { percent: 30 },
			},
		});
		expect(quota.plan).toBe("go");
		expect(quota.windows).toMatchObject([
			{ usedPercent: 125, durationSeconds: 18000, resetAt: Date.parse("2027-01-01T00:00:00Z") },
			{ durationSeconds: 604800 },
			{ label: "Monthly", durationSeconds: null },
		]);
	});
	it("rejects missing rolling usage and nonfinite percentages", () => {
		expect(() => parseOpenCodeGoQuota({ usage: {} })).toThrow(ProviderQuotaReadError);
		expect(() => parseOpenCodeGoQuota({ usage: { rolling: { percent: Infinity } } })).toThrow(ProviderQuotaReadError);
	});
});
