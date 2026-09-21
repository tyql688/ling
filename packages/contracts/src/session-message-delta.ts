import type { AssistantSessionMessage, SessionMessage } from "./session-messages";

export interface SessionMessageDelta {
	type: "messageDelta";
	messageId: string;
	occurredAt: number;
	changes: Array<{ part: number; kind: "text" | "thinking"; offset: number; append: string }>;
}

export class SessionMessageDeltaMismatch extends Error {
	constructor(messageId: string) {
		super(`Session message delta has no matching baseline: ${messageId}`);
		this.name = "SessionMessageDeltaMismatch";
	}
}

/** Encodes only append-only text/thinking changes. Structural, usage and tool changes require a full frame. */
export function createSessionMessageDelta(
	previous: AssistantSessionMessage,
	next: AssistantSessionMessage,
): SessionMessageDelta | null {
	const { content: before, occurredAt: _beforeTime, ...beforeMetadata } = previous;
	const { content: after, occurredAt, ...afterMetadata } = next;
	if (before.length !== after.length || JSON.stringify(beforeMetadata) !== JSON.stringify(afterMetadata)) return null;
	const changes: SessionMessageDelta["changes"] = [];
	for (const [part, current] of after.entries()) {
		const prior = before[part];
		if (!prior || prior.type !== current.type) return null;
		if (current.type === "toolCall") {
			if (JSON.stringify(prior) !== JSON.stringify(current)) return null;
			continue;
		}
		const beforeText = prior.type === "text" ? prior.text : prior.type === "thinking" ? prior.thinking : null;
		const afterText = current.type === "text" ? current.text : current.thinking;
		if (beforeText === null || !afterText.startsWith(beforeText)) return null;
		if (afterText !== beforeText)
			changes.push({ part, kind: current.type, offset: beforeText.length, append: afterText.slice(beforeText.length) });
	}
	return { type: "messageDelta", messageId: next.id, occurredAt, changes };
}

/** Offsets count UTF-16 code units, matching JS strings. An authoritative snapshot may already contain an append. */
export function applySessionMessageDelta(
	message: SessionMessage | undefined,
	delta: SessionMessageDelta,
): AssistantSessionMessage {
	if (message?.role !== "assistant" || message.id !== delta.messageId)
		throw new SessionMessageDeltaMismatch(delta.messageId);
	const content = [...message.content];
	for (const change of delta.changes) {
		const part = content[change.part];
		if (part?.type !== change.kind) throw new SessionMessageDeltaMismatch(delta.messageId);
		const current = part.type === "text" ? part.text : part.thinking;
		if (
			current.length < change.offset ||
			!change.append.startsWith(current.slice(change.offset, change.offset + change.append.length))
		)
			throw new SessionMessageDeltaMismatch(delta.messageId);
		const missing = change.append.slice(Math.max(0, current.length - change.offset));
		content[change.part] =
			part.type === "text" ? { ...part, text: current + missing } : { ...part, thinking: current + missing };
	}
	return { ...message, content, occurredAt: Math.max(message.occurredAt, delta.occurredAt) };
}
