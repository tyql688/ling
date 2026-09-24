import { z } from "zod";
import { portableAbsolutePathSchema } from "./path-validation";

export const VOICE_PACKAGE = "@earendil-works/pi-voice";
export const VOICE_BUNDLED_SOURCE = "ling:voice";
export const VOICE_SAMPLE_RATE = 16_000;
/** Two minutes bounds microphone retention and the PCM carried through both authenticated protocols. */
export const VOICE_MAX_SECONDS = 120;
export const VOICE_MAX_SAMPLES = VOICE_SAMPLE_RATE * VOICE_MAX_SECONDS;
export const VOICE_PCM_MAX_BYTES = VOICE_MAX_SAMPLES * 2;

export const voiceProjectSchema = z.strictObject({ cwd: portableAbsolutePathSchema("Project path") });
export const voiceConfigurationSchema = z.strictObject({
	modelId: z.string().min(1).max(256),
	language: z.string().min(1).max(32),
	chineseOutput: z.enum(["simplified", "traditional-taiwan", "traditional-hong-kong"]),
});
export type VoiceConfiguration = z.infer<typeof voiceConfigurationSchema>;
export const voiceConfigureRequestSchema = voiceProjectSchema.extend({
	operationId: z.uuid(),
	configuration: voiceConfigurationSchema,
	/** A separate explicit action permits downloading the selected model. */
	download: z.boolean(),
});
export type VoiceConfigureRequest = z.infer<typeof voiceConfigureRequestSchema>;
export const voiceTranscribeRequestSchema = voiceProjectSchema.extend({
	operationId: z.uuid(),
	pcm: z
		.string()
		.min(4)
		.max(Math.ceil(VOICE_PCM_MAX_BYTES / 3) * 4)
		.regex(/^[A-Za-z0-9+/]+={0,2}$/)
		.refine((value) => value.length % 4 === 0, "Incomplete base64 recording"),
});
export type VoiceTranscribeRequest = z.infer<typeof voiceTranscribeRequestSchema>;
export const voiceOverviewSchema = z.strictObject({
	source: z.string().min(1).max(2048),
	version: z.string().min(1).max(100),
	configuration: voiceConfigurationSchema.nullable(),
	warning: z.string().max(16_384).nullable(),
	models: z
		.array(
			z.strictObject({
				id: z.string().min(1).max(256),
				name: z.string().min(1).max(256),
				bytes: z.number().int().positive(),
				languages: z.array(z.string().max(32)).max(256),
				autoDetect: z.boolean(),
				downloaded: z.boolean(),
			}),
		)
		.max(512),
});
export type VoiceOverview = z.infer<typeof voiceOverviewSchema>;
export const voiceTranscriptSchema = z.strictObject({ text: z.string().max(65_536) });
export const voiceCancelRequestSchema = z.strictObject({ operationId: z.uuid() });

/** Exact package identities only; similarly named third-party extensions retain their own UI. */
export function isPiVoiceSource(source: string): boolean {
	return (
		source === VOICE_BUNDLED_SOURCE ||
		/^npm:@earendil-works\/pi-voice(?:@[^/]+)?$/.test(source) ||
		/^(?:git:|https:\/\/|ssh:\/\/git@)github\.com\/earendil-works\/pi-voice(?:\.git)?(?:@[^/]+)?$/.test(source)
	);
}
