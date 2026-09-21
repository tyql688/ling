import { generationDurationMsSchema } from "@ling/contracts/session-messages";
import { record } from "@ling/contracts/records";
import { z } from "zod";
import { createLogger } from "../../logger";
import type { PiAgentSessionEvent, PiSessionManager } from "../types";

const entryType = "ling:assistant-generation:v1";
const timingSchema = z.strictObject({
	timestamp: z.number().nonnegative(),
	durationMs: generationDurationMsSchema,
});
const log = createLogger("assistant-generation");
type StreamEvent = Extract<PiAgentSessionEvent, { type: "message_update" }>["assistantMessageEvent"];

/** Matches DSH's decode interval: text, thinking and tool arguments count; framing and usage do not. */
function hasOutputToken(event: StreamEvent): boolean {
	if (event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta")
		return event.delta.length > 0;
	if (event.type === "toolcall_start") {
		const part = event.partial.content[event.contentIndex];
		return part?.type === "toolCall" && part.name.length > 0;
	}
	return false;
}

/** A marker immediately precedes its assistant entry, so timing survives reloads and forks at that message. */
export function readAssistantGeneration(manager: PiSessionManager, entryId: string): number | undefined {
	const entry = manager.getEntry(entryId);
	if (entry?.type !== "message" || entry.message.role !== "assistant" || entry.parentId === null) return undefined;
	const marker = manager.getEntry(entry.parentId);
	if (marker?.type !== "custom" || marker.customType !== entryType) return undefined;
	const parsed = timingSchema.safeParse(marker.data);
	if (!parsed.success) {
		log.warn(`Invalid generation timing in entry ${marker.id}:`, parsed.error);
		return undefined;
	}
	return parsed.data.timestamp === entry.message.timestamp ? parsed.data.durationMs : undefined;
}

/** One active attempt per adapter; finalized objects are weakly held and never mutate Pi's messages. */
export function createAssistantGeneration(manager: PiSessionManager) {
	let active: { messageId: string; firstTokenAt: number | null } | null = null;
	const completed = new WeakMap<object, number>();
	return {
		start(messageId: string) {
			active = { messageId, firstTokenAt: null };
		},
		update(messageId: string, event: StreamEvent) {
			if (active?.messageId === messageId && active.firstTokenAt === null && hasOutputToken(event))
				active.firstTokenAt = performance.now();
		},
		finish(messageId: string, message: Extract<PiAgentSessionEvent, { type: "message_end" }>["message"]) {
			if (active?.messageId !== messageId) return;
			const firstTokenAt = active.firstTokenAt;
			active = null;
			// Failed/cancelled requests may carry partial content but no authoritative completion usage.
			if (
				firstTokenAt === null ||
				message.role !== "assistant" ||
				message.stopReason === "error" ||
				message.stopReason === "aborted" ||
				message.usage.output <= 0
			)
				return;
			const durationMs = performance.now() - firstTokenAt;
			if (durationMs <= 0) return;
			completed.set(message, durationMs);
			// Pi persists message_end immediately after notifying subscribers. Use its public
			// custom-entry API before that write; these measurements never enter model context.
			manager.appendCustomEntry(entryType, timingSchema.parse({ timestamp: message.timestamp, durationMs }));
		},
		project(value: unknown, entryId: string | null): unknown {
			const message = record(value);
			if (message?.role !== "assistant") return value;
			const duration =
				completed.get(message) ?? (entryId === null ? undefined : readAssistantGeneration(manager, entryId));
			return duration === undefined ? value : { ...message, generationDurationMs: duration };
		},
		clear() {
			active = null;
		},
	};
}
