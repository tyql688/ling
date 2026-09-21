import type { LingSessionEvent } from "./session";
import type { RenderedTextSnapshot } from "./session-messages";

/** Bound each live text preview to 64 Ki characters; final results own complete content and images. */
export const TOOL_PROGRESS_MAX_CHARS = 64 * 1024;
/** Bound simultaneous tool previews even if a tool never supplies its completion event. */
const MAX_TOOL_PROGRESS_ITEMS = 128;

export interface ToolExecutionProgress {
	toolCallId: string;
	toolName: string;
	text: string;
	truncated: boolean;
	rendered?: RenderedTextSnapshot;
}

/** Same immutable live-state projection in the Host snapshot and Web event consumer. */
export function applyToolExecutionProgress(
	current: readonly ToolExecutionProgress[],
	event: LingSessionEvent,
): readonly ToolExecutionProgress[] {
	if (
		event.type === "sessionReplaced" ||
		event.type === "transcriptInvalidated" ||
		(event.type === "runStarted" && event.runId === "agent") ||
		event.type === "runFinished"
	) {
		return current.length === 0 ? current : [];
	}
	if (event.type === "messageEnd" && event.message.role === "toolResult") {
		const id = event.message.toolCallId;
		return current.some((item) => item.toolCallId === id) ? current.filter((item) => item.toolCallId !== id) : current;
	}
	if (event.type !== "toolExecutionChanged") return current;
	const progress = event.progress;
	const index = current.findIndex((item) => item.toolCallId === event.toolCallId);
	if (progress === null) return index < 0 ? current : current.filter((item) => item.toolCallId !== event.toolCallId);
	if (progress.toolCallId !== event.toolCallId) throw new Error("Tool progress identity does not match its event.");
	if (index >= 0) return current.map((item, itemIndex) => (itemIndex === index ? progress : item));
	if (current.length >= MAX_TOOL_PROGRESS_ITEMS) throw new Error("Too many simultaneous tool output previews.");
	return [...current, progress];
}
