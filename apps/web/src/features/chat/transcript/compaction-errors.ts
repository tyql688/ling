import type { SessionMessage } from "@ling/contracts/session";
import { partsText } from "@renderer/features/chat/transcript/message-text";

type AssistantMessage = Extract<SessionMessage, { role: "assistant" }>;

/**
 * Regex set that recognizes "context window overflow" assistant error text.
 * A match can prompt auto-compaction; covers common English error phrasings from providers.
 */
const CONTEXT_WINDOW_ERROR_PATTERNS = [
	/\bcontext window\b/i,
	/\binput exceeds\b/i,
	/\bexceeds? (?:the )?(?:maximum )?context\b/i,
	/\bmaximum context length\b/i,
];

function assistantErrorText(message: AssistantMessage): string {
	const contentText = partsText(message.content);
	return [message.errorMessage, contentText].filter((part) => part && part.length > 0).join("\n");
}

function isContextWindowError(message: SessionMessage): message is AssistantMessage {
	if (message.role !== "assistant" || message.stopReason !== "error") return false;
	const errorText = assistantErrorText(message);
	return CONTEXT_WINDOW_ERROR_PATTERNS.some((pattern) => pattern.test(errorText));
}

export function isResolvedByLaterCompaction(messages: readonly SessionMessage[], messageIndex: number): boolean {
	const message = messages[messageIndex];
	if (!message || !isContextWindowError(message)) return false;
	const messageTimestamp = message.timestamp;
	return messages.some((next, nextIndex) => {
		if (next.role !== "compactionSummary") return false;
		if (nextIndex > messageIndex) return true;
		return typeof messageTimestamp === "number" && next.timestamp >= messageTimestamp;
	});
}
