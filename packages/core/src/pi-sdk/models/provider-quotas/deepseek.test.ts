import { describe, expect, it } from "vitest";
import { parseDeepSeekQuota } from "./deepseek";
import { ProviderQuotaReadError } from "./shared";

describe("DeepSeek balance payload", () => {
	it("preserves negative balances and deduplicates currencies without inventing limits", () => {
		const balance = (currency: string, total_balance: string) => ({
			currency,
			total_balance,
			granted_balance: "0",
			topped_up_balance: "1",
		});
		expect(
			parseDeepSeekQuota({
				is_available: false,
				balance_infos: [balance("USD", "-1.25"), balance("USD", "99"), balance("CNY", "6"), balance("???", "2")],
			}),
		).toEqual({
			plan: null,
			windows: [],
			amounts: [
				{ kind: "balance", period: null, value: -1.25, limit: null, unit: "USD" },
				{ kind: "balance", period: null, value: 6, limit: null, unit: "CNY" },
			],
		});
	});
	it("rejects malformed and nonfinite balances", () => {
		expect(() => parseDeepSeekQuota(null)).toThrow(ProviderQuotaReadError);
		expect(() =>
			parseDeepSeekQuota({
				is_available: true,
				balance_infos: [{ currency: "USD", total_balance: "Infinity", granted_balance: 0, topped_up_balance: 0 }],
			}),
		).toThrow(ProviderQuotaReadError);
	});
});
