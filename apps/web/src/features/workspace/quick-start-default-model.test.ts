import type { ModelInfo } from "@ling/contracts/session";
import { describe, expect, it } from "vitest";
import { resolveQuickStartSelectedModel, resolveQuickStartThinkingLevel } from "./quick-start-default-model";

describe("quick-start model selection across folders", () => {
	it("retains the draft's choice using the destination catalog and its supported thinking levels", () => {
		const selected = { provider: "project-provider", id: "reasoning-model" };
		const destinationModel: ModelInfo = {
			...selected,
			providerName: "Project provider",
			name: "Destination model",
			reasoning: true,
			availableThinkingLevels: ["off", "high"],
			contextWindow: 64000,
		};
		const resolved = resolveQuickStartSelectedModel(selected, [destinationModel]);
		expect(resolved).toBe(destinationModel);
		expect(resolveQuickStartThinkingLevel({ defaultThinkingLevel: "high" }, resolved?.availableThinkingLevels)).toBe(
			"high",
		);
		expect(resolveQuickStartThinkingLevel({ defaultThinkingLevel: "xhigh" }, resolved?.availableThinkingLevels)).toBe(
			"high",
		);
	});

	it("never resolves a previous folder's model while loading or when unavailable at the destination", () => {
		const selected = { provider: "private-provider", id: "same-id" };
		expect(resolveQuickStartSelectedModel(selected, [])).toBeNull();
		expect(
			resolveQuickStartSelectedModel(selected, [
				{
					provider: "other-provider",
					providerName: "Other provider",
					id: selected.id,
					name: "Another model with the same id",
					reasoning: false,
					availableThinkingLevels: ["off"],
					contextWindow: 32000,
				},
			]),
		).toBeNull();
	});
});
