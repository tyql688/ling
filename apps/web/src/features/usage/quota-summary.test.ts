import { describe, expect, it } from "vitest";
import type { ProviderQuotaWindow } from "@ling/contracts/usage";
import { preferredQuotaWindow } from "./quota-summary";

function window(id: string, kind: ProviderQuotaWindow["kind"], durationSeconds: number | null): ProviderQuotaWindow {
	return {
		id,
		kind,
		durationSeconds,
		label: null,
		usedPercent: 14,
		used: null,
		limit: null,
		remaining: null,
		unit: null,
		resetAt: null,
		unlimited: false,
	};
}

describe("provider quota summary", () => {
	it("chooses the shortest account window without substituting a model allowance", () => {
		const week = window("account-week", "rolling", 604800);
		const short = window("account-short", "rolling", 18000);
		const model = window("additional-model", "model", 3600);
		expect(preferredQuotaWindow([model, week, short])).toBe(short);
		expect(preferredQuotaWindow([model, week])).toBe(week);
	});
	it("keeps an account window with an unknown duration and handles new model lanes without name matching", () => {
		const account = window("account", "rolling", null);
		const model = window("future-model", "model", 7200);
		expect(preferredQuotaWindow([model, account])).toBe(account);
		expect(preferredQuotaWindow([model])).toBe(model);
		expect(preferredQuotaWindow([])).toBeNull();
	});
});
