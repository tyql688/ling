import type { SessionMessage } from "@ling/contracts/session";

export function sessionMessageRowIdentity(message: SessionMessage): string {
	return `message:${message.id}`;
}

export function sameSessionMessageIdentity(left: SessionMessage, right: SessionMessage): boolean {
	if (left.id === right.id) return true;
	return Boolean(left.entryId && right.entryId && left.entryId === right.entryId);
}

/** Incoming content wins unless a deferred summary would discard an already-loaded tool result.
 * An already-rendered live row keeps its generation-scoped key.
 * Durable identity can arrive later through messagePersisted or an authoritative snapshot. */
export function mergeSessionMessageIdentity(existing: SessionMessage, incoming: SessionMessage): SessionMessage {
	const content =
		existing.role === "toolResult" &&
		existing.contentState !== "deferred" &&
		incoming.role === "toolResult" &&
		incoming.contentState === "deferred"
			? existing
			: incoming;
	return {
		...content,
		id: existing.id,
		entryId: incoming.entryId ?? existing.entryId,
	};
}

export function attachDurableMessageIdentity(message: SessionMessage, entryId: string): SessionMessage {
	return { ...message, entryId };
}
