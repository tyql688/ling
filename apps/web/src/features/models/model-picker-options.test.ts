import { describe, expect, it } from "vitest";
import {
	filterModelPickerOptions,
	filterModelPickerProviders,
	modelPickerMatchParts,
	type ModelPickerOption,
} from "./model-picker-options";

const models: ModelPickerOption[] = [
	{ provider: "openrouter", providerName: "OpenRouter", id: "openai/gpt-5", name: "OpenAI: GPT-5", reasoning: true },
	{
		provider: "anthropic",
		providerName: "Anthropic",
		id: "claude-sonnet-4-5",
		name: "Claude Sonnet 4.5",
		reasoning: true,
	},
	{ provider: "anthropic", providerName: "Anthropic", id: "claude-opus-4-1", name: "Claude Opus 4.1", reasoning: true },
	{
		provider: "openrouter",
		providerName: "OpenRouter",
		id: "anthropic/claude-sonnet-4.5",
		name: "Anthropic: Claude Sonnet 4.5",
		reasoning: true,
	},
	{ provider: "openai", providerName: "OpenAI", id: "gpt-5", name: "GPT-5", reasoning: true },
	{ provider: "openai", providerName: "OpenAI", id: "gpt-5-mini", name: "GPT-5 mini", reasoning: true },
	{ provider: "google", providerName: "Google", id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", reasoning: true },
];
const keys = (options: ModelPickerOption[]) => options.map((option) => `${option.provider}/${option.id}`);

describe("model picker search", () => {
	it("matches all whitespace/slash tokens regardless of order, including abbreviations", () => {
		for (const query of ["anthropic son45", "son45/anthropic", "  ANTHROPIC / 45son  "]) {
			expect(keys(filterModelPickerOptions(models, query))).toEqual([
				"anthropic/claude-sonnet-4-5",
				"openrouter/anthropic/claude-sonnet-4.5",
			]);
		}
		expect(filterModelPickerOptions(models, "son45 nonexistent")).toEqual([]);
	});

	it("ranks direct provider matches before a selected proxy model with a provider-prefixed ID", () => {
		expect(
			keys(
				filterModelPickerOptions(models, "openai/gpt5", { selected: { provider: "openrouter", id: "openai/gpt-5" } }),
			),
		).toEqual(["openai/gpt-5", "openai/gpt-5-mini", "openrouter/openai/gpt-5"]);
	});

	it("filters on the actual provider while retaining fuzzy search and localized provider names", () => {
		expect(keys(filterModelPickerOptions(models, "anthropic son45", { provider: "openrouter" }))).toEqual([
			"openrouter/anthropic/claude-sonnet-4.5",
		]);
		expect(filterModelPickerOptions(models, "openrouter", { provider: "openai" })).toEqual([]);
		const localized = [{ provider: "local", providerName: "本地服务", id: "qwen3", name: "Qwen 3", reasoning: false }];
		expect(filterModelPickerOptions(localized, "本地 qwen3")).toEqual(localized);
	});

	it("browses current then default and resolves default prefixes without adding unavailable models", () => {
		const selected = { provider: "google", id: "gemini-2.5-pro" };
		const defaultModel = { provider: "openai", id: "gpt-5" };
		for (const query of ["", " / "]) {
			expect(keys(filterModelPickerOptions(models, query, { selected, defaultModel })).slice(0, 2)).toEqual([
				"google/gemini-2.5-pro",
				"openai/gpt-5",
			]);
		}
		for (const query of ["d", "def", "DEFAULT"]) {
			expect(keys(filterModelPickerOptions(models, query, { selected, defaultModel }))[0]).toBe("openai/gpt-5");
		}
		expect(filterModelPickerOptions(models, "default", { defaultModel, provider: "google" })).toEqual([]);
		expect(
			filterModelPickerOptions(models, "default", { defaultModel: { provider: "missing", id: "missing" } }),
		).toEqual([]);
	});

	it("does not reorder the source catalog when ranking or browsing", () => {
		const original = [...models];
		filterModelPickerOptions(models, "");
		filterModelPickerOptions(models, "gpt5");
		expect(models).toEqual(original);
	});

	it("searches actual provider names and IDs independently of model keywords and result counts", () => {
		const providers = [
			{ id: "openrouter", name: "OpenRouter", count: 2 },
			{ id: "openai", name: "OpenAI", count: 0 },
			{ id: "local", name: "本地服务", count: 1 },
		];
		expect(filterModelPickerProviders(providers, "OPEN/ROUT")).toEqual([providers[0]]);
		expect(filterModelPickerProviders(providers, "openai")).toEqual([providers[1]]);
		expect(filterModelPickerProviders(providers, "本地 local")).toEqual([providers[2]]);
		expect(filterModelPickerProviders(providers, "son45")).toEqual([]);
		expect(filterModelPickerProviders(providers, "open nonexistent")).toEqual([]);
		expect(providers.map((item) => item.id)).toEqual(["openrouter", "openai", "local"]);
	});

	it("does not match provider abbreviations by joining repeated identity fields", () => {
		const providers = [
			{ id: "anthropic", name: "Anthropic", count: 2 },
			{ id: "openrouter", name: "OpenRouter", count: 4 },
			{ id: "local-fixture-10", name: "local-fixture-10", count: 1 },
			{ id: "local-fixture-11", name: "local-fixture-11", count: 1 },
		];
		expect(filterModelPickerProviders(providers, "opnr")).toEqual([providers[1]]);
		expect(filterModelPickerProviders(providers, "local-fixture-11")).toEqual([providers[3]]);
	});

	it("highlights field matches with the same abbreviation fallback without losing label characters", () => {
		const highlighted = (text: string, query: string) =>
			modelPickerMatchParts(text, query)
				.filter((part) => part.matched)
				.map((part) => part.text)
				.join("");
		expect(highlighted("Claude Sonnet 4.5", "anthropic 45son")).toBe("Son45");
		expect(highlighted("openrouter/anthropic/claude-sonnet-4.5", "openrouter son45")).toBe("openrouterson45");
		expect(highlighted("本地服务", "本地 qwen")).toBe("本地");
		for (const label of ["Claude Sonnet 4.5", "İstanbul 模型 🧠", "𝙈odel"]) {
			expect(
				modelPickerMatchParts(label, "i 模型 🧠")
					.map((part) => part.text)
					.join(""),
			).toBe(label);
		}
		expect(highlighted("GPT-5", "nonexistent")).toBe("");
		expect(modelPickerMatchParts("GPT-5", "")).toEqual([{ text: "GPT-5", matched: false, start: 0 }]);
	});
});
