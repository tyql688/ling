import { z } from "zod";
import { controlFreeString, hardenObjectSchema } from "./schema-primitives";
import type { AppSettingsUpdate } from "./application";
import { PROJECT_LAUNCH_TARGET_IDS } from "./project";
import { TERMINAL_PROFILE_ID_MAX_CHARS } from "./terminal";

export const appSettingsUpdateSchema: z.ZodType<AppSettingsUpdate> = hardenObjectSchema(
	z.discriminatedUnion("type", [
		z.strictObject({ type: z.literal("keepRunningOnWindowClose"), enabled: z.boolean() }),
		z.strictObject({ type: z.literal("disableHardwareAcceleration"), enabled: z.boolean() }),
		z.strictObject({ type: z.literal("notifyBackgroundCompletion"), enabled: z.boolean() }),
		z.strictObject({ type: z.literal("notifyAttentionNeeded"), enabled: z.boolean() }),
		z.strictObject({ type: z.literal("playNotificationSounds"), enabled: z.boolean() }),
		z.strictObject({ type: z.literal("fileMentionsRespectGitignore"), enabled: z.boolean() }),
		z.strictObject({ type: z.literal("keepAwakeWhileRunning"), enabled: z.boolean() }),
		z.strictObject({
			type: z.literal("projectLauncher"),
			kind: z.enum(["file-manager", "editor", "terminal"]),
			targetId: z.enum(PROJECT_LAUNCH_TARGET_IDS).nullable(),
		}),
		z.strictObject({
			type: z.literal("integratedTerminalProfile"),
			profileId: controlFreeString(TERMINAL_PROFILE_ID_MAX_CHARS, "Terminal profile id").nullable(),
		}),
	]),
);

export const emptyAppSettingsRequestSchema = z.undefined();
