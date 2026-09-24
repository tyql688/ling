import { expect, it } from "vitest";
import type { VoiceOverview } from "@ling/contracts/voice";
import { preferredVoiceModels, voiceLanguageForModel } from "./voice-models";

const model = (languages: string[], autoDetect = false): VoiceOverview["models"][number] => ({
	id: languages.join(","),
	name: "Model",
	bytes: 100,
	languages,
	autoDetect,
	downloaded: false,
});

it("keeps an explicit regional language and maps to the new model's supported regional code", () => {
	expect(voiceLanguageForModel(model(["en-US", "en-GB"], true), "en-GB", "zh-CN")).toBe("en-GB");
	expect(voiceLanguageForModel(model(["en", "zh-CN"], true), "zh", "en")).toBe("zh-CN");
	expect(voiceLanguageForModel(model(["yue", "en"], true), "zh", "en")).toBe("auto");
});

it("uses detection only when supported and otherwise picks a supported language", () => {
	expect(voiceLanguageForModel(model(["en", "ja"], true), "auto", "ja")).toBe("auto");
	expect(voiceLanguageForModel(model(["en", "ja"]), "auto", "ja")).toBe("ja");
	expect(voiceLanguageForModel(model(["en"]), "ko", "ja")).toBe("en");
});

it("prefers the interface language before download status without changing the catalog", () => {
	const english = { ...model(["en"]), downloaded: true };
	const mandarin = model(["zh", "en"]);
	const japanese = model(["ja"]);
	const catalog = [english, mandarin, japanese];
	expect(preferredVoiceModels(catalog, "zh-CN")).toEqual([mandarin, english, japanese]);
	expect(preferredVoiceModels(catalog, "ja")[0]).toBe(japanese);
	expect(catalog).toEqual([english, mandarin, japanese]);
});
