import type { VoiceOverview } from "@ling/contracts/voice";

type VoiceModel = VoiceOverview["models"][number];

export function preferredVoiceModels(models: VoiceModel[], locale: string): VoiceModel[] {
	const language = locale.split("-")[0];
	const matches = (model: VoiceModel) => model.languages.some((code) => code.split("-")[0] === language);
	return [...models].sort(
		(a, b) =>
			Number(matches(b)) - Number(matches(a)) || Number(b.downloaded) - Number(a.downloaded) || a.bytes - b.bytes,
	);
}

/** Keep the chosen language, including its regional code, whenever the new model supports it. */
export function voiceLanguageForModel(model: VoiceModel, current: string, locale: string): string {
	if (current === "auto" && model.autoDetect) return current;
	const exact = model.languages.find((code) => code === current);
	if (exact) return exact;
	const equivalent = model.languages.find((code) => code.split("-")[0] === current.split("-")[0]);
	if (equivalent) return equivalent;
	if (model.autoDetect) return "auto";
	return model.languages.find((code) => code.split("-")[0] === locale.split("-")[0]) ?? model.languages[0]!;
}
