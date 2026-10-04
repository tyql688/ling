import type { SessionEventEnvelope, TranscriptPage } from "@ling/contracts/session";
import type { SessionMessage } from "@ling/contracts/session-messages";
import { mergeSessionMessageIdentity } from "./session-message-identity";
import type { SessionTranscriptState } from "@renderer/features/sessions/state/session";

interface SessionTranscriptProjection {
	messages: SessionMessage[];
	state: SessionTranscriptState;
}

/** A freshly created runtime has no older pages by construction, even before its first snapshot binds. */
export function markTranscriptKnownEmpty(state: SessionTranscriptState): SessionTranscriptState {
	return state.hydrationSettled && state.knownEmptySeedPending
		? state
		: { ...state, hydrationSettled: true, knownEmptySeedPending: true };
}

function sameBinding(state: SessionTranscriptState, page: TranscriptPage): boolean {
	return state.runtimeId === page.runtimeId && state.generation === page.generation;
}

/** A page owns branch order. Arrival order cannot place history around live messages after a reload. */
function mergeTranscriptPage(
	current: SessionMessage[],
	items: readonly SessionMessage[],
	direction: "older" | "tail",
): SessionMessage[] {
	if (items.length === 0) return current;
	const byId = new Map(current.map((message, index) => [message.id, index]));
	const byEntryId = new Map<string, number>();
	for (const [index, message] of current.entries()) {
		if (message.entryId) byEntryId.set(message.entryId, index);
	}
	const matched = new Set<number>();
	let firstMatch = current.length;
	const page = items.map((message) => {
		const index = byId.get(message.id) ?? (message.entryId ? byEntryId.get(message.entryId) : undefined);
		if (index === undefined) return message;
		const existing = current[index]!;
		matched.add(index);
		firstMatch = Math.min(firstMatch, index);
		// Older pages are pinned before subsequent live updates. Only a current tail may replace content.
		return direction === "older" ? existing : mergeSessionMessageIdentity(existing, message);
	});
	// Without an overlap, older pages precede the projection; a new tail follows durable
	// history but precedes any unpersisted live suffix. Timestamps are never ordering keys.
	const boundary =
		matched.size > 0
			? firstMatch
			: direction === "older"
				? 0
				: current.findLastIndex((message) => message.entryId !== null) + 1;
	const merged = [
		...current.slice(0, boundary),
		...page,
		...current.slice(boundary).filter((_message, index) => !matched.has(boundary + index)),
	];
	return merged.length === current.length && merged.every((message, index) => message === current[index])
		? current
		: merged;
}

export function applyTranscriptTail(
	currentMessages: SessionMessage[],
	currentState: SessionTranscriptState,
	tail: TranscriptPage,
): SessionTranscriptProjection {
	const bindingMatches = sameBinding(currentState, tail);
	/** Both states belong to this session's atoms. A binding mismatch therefore means runtime replacement within the same session file. Merge persisted history and keep hydrationSettled so long transcripts stay mounted. Drop the previous generation's unpersisted messages, which Pi's disk snapshot cannot restore. */
	const carried = bindingMatches ? currentMessages : currentMessages.filter((message) => message.entryId !== null);
	/** Interpret hasOlder:false as complete history after hydration settles. The empty state also defaults to false, and live events can arrive before its snapshot. Checking hydration prevents those events from marking an incomplete tail as the full history. */
	const carriedAcrossRollover = !bindingMatches && carried.length > 0 && currentState.hydrationSettled;
	const historyAlreadyComplete = (bindingMatches || carriedAcrossRollover) && !currentState.hasOlder;
	const sameHydrationAttempt =
		bindingMatches && currentState.chainRevision === tail.transcriptRevision && currentState.hydrationSettled;
	const messages = mergeTranscriptPage(carried, tail.items, "tail");
	return {
		messages,
		state: {
			runtimeId: tail.runtimeId,
			generation: tail.generation,
			currentRevision: tail.transcriptRevision,
			chainRevision: tail.transcriptRevision,
			transcriptCacheKey: currentState.transcriptCacheKey,
			olderCursor: historyAlreadyComplete ? null : (tail.olderCursor ?? null),
			hasOlder: historyAlreadyComplete ? false : tail.hasOlder,
			hydrationSettled:
				historyAlreadyComplete ||
				sameHydrationAttempt ||
				(carriedAcrossRollover && currentState.hydrationSettled) ||
				!tail.hasOlder,
			historyError: sameHydrationAttempt && tail.hasOlder ? currentState.historyError : null,
			historyLoading:
				bindingMatches && currentState.chainRevision === tail.transcriptRevision && tail.hasOlder
					? currentState.historyLoading
					: false,
			knownEmptySeedPending: currentState.knownEmptySeedPending,
			limit: tail.limit,
			epoch: currentState.epoch,
		},
	};
}

export function mergeHistoricalTranscriptPages(
	currentMessages: SessionMessage[],
	currentState: SessionTranscriptState,
	pages: readonly TranscriptPage[],
): SessionMessage[] | null {
	if (
		pages.some((page) => !sameBinding(currentState, page) || page.transcriptRevision > currentState.currentRevision)
	) {
		return null;
	}
	return mergeTranscriptPage(
		currentMessages,
		pages.toReversed().flatMap((page) => page.items),
		"older",
	);
}

export function advanceTranscriptRevision(
	state: SessionTranscriptState,
	envelope: SessionEventEnvelope,
): SessionTranscriptState {
	if (state.runtimeId !== envelope.runtimeId || state.generation !== envelope.generation) return state;
	const projectionInvalidated =
		envelope.event.type === "snapshotChanged" ||
		envelope.event.type === "transcriptInvalidated" ||
		envelope.event.type === "transcriptProjectionChanged";
	if (state.currentRevision === envelope.transcriptRevision && !projectionInvalidated) return state;
	return {
		...state,
		currentRevision: envelope.transcriptRevision,
		...(projectionInvalidated ? { transcriptCacheKey: null } : {}),
	};
}
