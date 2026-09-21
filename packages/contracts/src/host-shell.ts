import { z } from "zod";
import { sessionRefSchema, type SessionRef } from "./session-ref";

/** Host event channel consumed by product-specific Shell adapters, never by feature state. */
export const HOST_SHELL_EVENT_CHANNEL = "host:shell-event";
export const HOST_SHELL_STATE_METHOD = "host:getShellState";
/** Native notification titles are intentionally short and never contain transcript-scale content. */
const HOST_NOTIFICATION_TITLE_MAX_CHARS = 256;
/** Notification previews remain useful while staying bounded well below OS-specific delivery limits. */
const HOST_NOTIFICATION_BODY_MAX_CHARS = 2_000;

export type HostNotificationKind = "backgroundCompletion" | "attentionNeeded";

export type HostShellEvent = z.infer<typeof hostShellEventSchema>;

export interface HostShellState {
	keepAwakeEnabled: boolean;
	keepRunningEnabled: boolean;
	runningRefs: SessionRef[];
}

const hostShellEventSchema = z.discriminatedUnion("type", [
	z.strictObject({ type: z.literal("agentRunState"), ref: sessionRefSchema, running: z.boolean() }),
	z.strictObject({ type: z.literal("keepAwakePreference"), enabled: z.boolean() }),
	z.strictObject({ type: z.literal("keepRunningPreference"), enabled: z.boolean() }),
	z.strictObject({ type: z.literal("graphicsPreference"), softwareRendering: z.boolean() }),
	z.strictObject({
		type: z.literal("notification"),
		ref: sessionRefSchema,
		title: z.string().min(1).max(HOST_NOTIFICATION_TITLE_MAX_CHARS),
		body: z.string().min(1).max(HOST_NOTIFICATION_BODY_MAX_CHARS),
		silent: z.boolean(),
		kind: z.enum(["backgroundCompletion", "attentionNeeded"]),
	}),
]);

export const hostSupervisorMessageSchema = z.discriminatedUnion("type", [
	z.strictObject({
		type: z.literal("ling-host-ready"),
		hostId: z.uuid(),
		origin: z.url(),
		token: z.string().min(32).max(256),
	}),
	z.strictObject({ type: z.literal("ling-host-shell-event"), event: hostShellEventSchema }),
]);

export type HostSupervisorMessage = z.infer<typeof hostSupervisorMessageSchema>;
export const HOST_STDIO_MESSAGE_PREFIX = "@@LING_HOST_CONTROL@@";

export interface HostConnectionInfo {
	url: string;
	token: string;
}
