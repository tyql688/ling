import { argumentsOf, request, returns } from "./procedure";
import {
	voiceProjectSchema,
	voiceConfigureRequestSchema,
	voiceTranscribeRequestSchema,
	voiceCancelRequestSchema,
	type VoiceOverview,
	type VoiceConfigureRequest,
	type VoiceTranscribeRequest,
} from "./voice";
import type { PiResourceReloadSummary } from "./session";

export const voiceProcedures = {
	read: request(
		"voice:read",
		argumentsOf((args): [{ cwd: string }] => [voiceProjectSchema.parse(args[0])]),
		returns<VoiceOverview>(),
	),
	configure: request(
		"voice:configure",
		argumentsOf((args): [VoiceConfigureRequest] => [voiceConfigureRequestSchema.parse(args[0])]),
		returns<PiResourceReloadSummary>(),
	),
	transcribe: request(
		"voice:transcribe",
		argumentsOf((args): [VoiceTranscribeRequest] => [voiceTranscribeRequestSchema.parse(args[0])]),
		returns<{ text: string }>(),
	),
	cancel: request(
		"voice:cancel",
		argumentsOf((args): [{ operationId: string }] => [voiceCancelRequestSchema.parse(args[0])]),
		returns<void>(),
	),
};
