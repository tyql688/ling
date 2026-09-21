import { applySessionMessageDelta } from "@ling/contracts/session-message-delta";
import type {
	AutoRetryStatus,
	LingSessionEvent,
	SessionMessage,
	SummarizationRetryStatus,
} from "@ling/contracts/session";
import {
	attachDurableMessageIdentity,
	mergeSessionMessageIdentity,
	sameSessionMessageIdentity,
} from "@renderer/features/sessions/runtime/session-message-identity";

interface SessionMessageMutation {
	previous: WeakRef<SessionMessage[]>;
	changedFromIndex: number;
}

const sessionMessageMutations = new WeakMap<readonly SessionMessage[], SessionMessageMutation>();

function recordMutation(
	previous: SessionMessage[],
	next: SessionMessage[],
	changedFromIndex: number,
): SessionMessage[] {
	// Background sessions have no projector to consume this lineage. It must never
	// keep every streamed version of their transcript alive through the current array.
	sessionMessageMutations.set(next, { previous: new WeakRef(previous), changedFromIndex });
	return next;
}

function replaceAt(messages: SessionMessage[], index: number, message: SessionMessage): SessionMessage[] {
	return recordMutation(messages, [...messages.slice(0, index), message, ...messages.slice(index + 1)], index);
}

function findMessageIndex(messages: readonly SessionMessage[], message: SessionMessage): number {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const candidate = messages[index];
		if (candidate && sameSessionMessageIdentity(candidate, message)) return index;
	}
	return -1;
}

function findMessageIdIndex(messages: readonly SessionMessage[], messageId: string): number {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		if (messages[index]?.id === messageId) return index;
	}
	return -1;
}

function upsertMessage(messages: SessionMessage[], message: SessionMessage): SessionMessage[] {
	const index = findMessageIndex(messages, message);
	if (index < 0) return recordMutation(messages, [...messages, message], messages.length);
	const existing = messages[index];
	return existing ? replaceAt(messages, index, mergeSessionMessageIdentity(existing, message)) : messages;
}

function promotePersistedMessage(
	messages: SessionMessage[],
	event: Extract<LingSessionEvent, { type: "messagePersisted" }>,
): SessionMessage[] {
	const index = findMessageIdIndex(messages, event.messageId);
	const message = messages[index];
	if (index < 0 || !message) return messages;
	return replaceAt(messages, index, attachDurableMessageIdentity(message, event.entryId));
}

/** Checks an immutable event-update lineage without scanning the frozen message prefix.
 * Snapshot, hydration, and collected intermediate arrays intentionally force a full projection. */
export function consumeUnchangedSessionMessagePrefix(
	previous: readonly SessionMessage[],
	next: readonly SessionMessage[],
	count: number,
): boolean {
	if (previous.length < count || next.length < count) {
		sessionMessageMutations.delete(next);
		return false;
	}
	let cursor = next;
	while (cursor !== previous) {
		const mutation = sessionMessageMutations.get(cursor);
		if (!mutation || mutation.changedFromIndex < count) {
			sessionMessageMutations.delete(next);
			return false;
		}
		const ancestor = mutation.previous.deref();
		if (!ancestor) {
			sessionMessageMutations.delete(next);
			return false;
		}
		cursor = ancestor;
	}
	// The next projection becomes the comparison baseline. Its lineage is no longer needed,
	// and dropping it prevents completed stream batches from retaining prior message arrays.
	sessionMessageMutations.delete(next);
	return true;
}

export function applySessionEvent(messages: SessionMessage[], event: LingSessionEvent): SessionMessage[] {
	switch (event.type) {
		case "messageDelta": {
			const message = messages.findLast((item) => item.id === event.messageId);
			return upsertMessage(messages, applySessionMessageDelta(message, event));
		}
		case "messageStart":
		case "messageUpdate":
		case "messageEnd":
		case "turnEnd":
		case "compactionSummary":
			return upsertMessage(messages, event.message);
		case "messagePersisted":
			return promotePersistedMessage(messages, event);
		default:
			return messages;
	}
}

/** Agent-turn busy/error only — lifecycle/file-sync runFinished must not mask agent state. */
function isAgentRunEvent(event: LingSessionEvent): boolean {
	return (event.type === "runStarted" || event.type === "runFinished") && "runId" in event && event.runId === "agent";
}

/** Runs that occupy the session for busy/queue routing: agent turns and idle compaction.
 * They never overlap (Pi compacts only outside agent runs), so a plain boolean suffices. */
function isBusyRunEvent(event: LingSessionEvent): boolean {
	return (
		(event.type === "runStarted" || event.type === "runFinished") &&
		"runId" in event &&
		(event.runId === "agent" || event.runId === "compaction")
	);
}

/** Returns the next busy state, or undefined if this event doesn't affect it. */
export function deriveBusyState(event: LingSessionEvent): boolean | undefined {
	if (!isBusyRunEvent(event)) return undefined;
	if (event.type === "runStarted") return true;
	if (event.type === "runFinished") return false;
	return undefined;
}

/** Returns a replacement auto-retry status, or undefined when an event does not own it. */
export function deriveAutoRetryStatus(event: LingSessionEvent): AutoRetryStatus | null | undefined {
	if (event.type === "autoRetryChanged") return event.status;
	// The retried attempt streaming again ends the wait (Pi's TUI swaps the retry indicator for
	// the working indicator at message_start); a further failure re-arms it via auto_retry_start.
	if (event.type === "messageStart" && event.message.role === "assistant") return null;
	if (event.type === "runFinished" && "runId" in event && event.runId === "agent") return null;
	if (event.type === "sessionReplaced") return null;
	return undefined;
}

/** Returns a replacement retry status, or undefined when an event does not own it. */
export function deriveSummarizationRetryStatus(event: LingSessionEvent): SummarizationRetryStatus | null | undefined {
	if (event.type === "summarizationRetryChanged") return event.status;
	if (event.type === "runFinished" && "runId" in event && event.runId === "agent") return null;
	if (event.type === "sessionReplaced") return null;
	return undefined;
}

/** Returns the session's sidebar/banner error projection, or undefined if this event doesn't own it. */
export function deriveErrorProjection(
	event: LingSessionEvent,
): { hasError: boolean; message: string | null } | undefined {
	if (!isAgentRunEvent(event)) return undefined;
	if (event.type === "runStarted") return { hasError: false, message: null };
	if (event.type === "runFinished") {
		return event.outcome.status === "failed"
			? { hasError: true, message: event.outcome.message }
			: { hasError: false, message: null };
	}
	return undefined;
}
