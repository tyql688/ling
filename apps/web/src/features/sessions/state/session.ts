import type { ToolExecutionProgress } from "@ling/contracts/session-tool-progress";
import type {
	ApprovalRequest,
	AutoRetryStatus,
	ExtensionUiRequest,
	RuntimeCommandCatalogSnapshot,
	RuntimeExtensionUiSnapshot,
	SessionQueue,
	SessionSummary,
	SummarizationRetryStatus,
} from "@ling/contracts/session";
import type { SessionMessage } from "@ling/contracts/session-messages";
import type { SessionRef } from "@ling/contracts/session-ref";
import { atom, type PrimitiveAtom, type WritableAtom, type SetStateAction } from "jotai";
import { atomFamily } from "jotai-family";

export const sessionsAtom = atom<SessionSummary[]>([]);
export const activeSessionRefAtom = atom<SessionRef | null>(null);
export const pendingApprovalQueueAtom = atom<ApprovalRequest[]>([]);
export const pendingExtensionUiQueueAtom = atom<ExtensionUiRequest[]>([]);
export interface SessionTranscriptState {
	runtimeId: string | null;
	generation: number;
	currentRevision: number;
	chainRevision: number;
	transcriptCacheKey: string | null;
	olderCursor: string | null;
	hasOlder: boolean;
	/** First-screen history load for the current binding has finished; stored per session so switching doesn't reuse the previous session's transient state. */
	hydrationSettled: boolean;
	/** History-read failures stay separate from send/turn errors and remain retryable for this binding. */
	historyError: string | null;
	historyLoading: boolean;
	/** A new session's empty history is pending intake by the downstream timeline projection; cleared once received so it isn't later mistaken for existing history. */
	knownEmptySeedPending: boolean;
	limit: number;
	epoch: number;
}

export function emptySessionTranscriptState(epoch = 0): SessionTranscriptState {
	return {
		runtimeId: null,
		generation: 0,
		currentRevision: 0,
		chainRevision: 0,
		transcriptCacheKey: null,
		olderCursor: null,
		hasOlder: false,
		hydrationSettled: false,
		historyError: null,
		historyLoading: false,
		knownEmptySeedPending: false,
		limit: 0,
		epoch,
	};
}

/** One record owns all state for a runtime view. Field selectors preserve narrow subscriptions. */
export interface SessionView {
	dismissedVoiceSettingsRequest: string | null;
	messages: SessionMessage[];
	transcript: SessionTranscriptState;
	toolExecutions: readonly ToolExecutionProgress[];
	busy: boolean;
	summarizationRetry: SummarizationRetryStatus | null;
	autoRetry: AutoRetryStatus | null;
	queue: SessionQueue;
	error: boolean;
	errorMessage: string | null;
	commandCatalog: RuntimeCommandCatalogSnapshot | null;
	extensionUi: RuntimeExtensionUiSnapshot | null;
}

export function emptySessionView(epoch = 0): SessionView {
	return {
		dismissedVoiceSettingsRequest: null,
		messages: [],
		transcript: emptySessionTranscriptState(epoch),
		toolExecutions: [],
		busy: false,
		summarizationRetry: null,
		autoRetry: null,
		queue: { revision: 0, steering: [], followUp: [] },
		error: false,
		errorMessage: null,
		commandCatalog: null,
		extensionUi: null,
	};
}

export const sessionViewFamily = atomFamily((_key: string) => atom(emptySessionView()));

function sessionField<Key extends keyof SessionView>(field: Key) {
	const selectors = new WeakMap<
		PrimitiveAtom<SessionView>,
		WritableAtom<SessionView[Key], [SetStateAction<SessionView[Key]>], void>
	>();
	return (key: string) => {
		const view = sessionViewFamily(key);
		let selector = selectors.get(view);
		if (!selector) {
			selector = atom(
				(get) => get(view)[field],
				(get, set, update: SetStateAction<SessionView[Key]>) => {
					const current = get(view);
					const value = typeof update === "function" ? update(current[field]) : update;
					if (!Object.is(value, current[field])) set(view, { ...current, [field]: value });
				},
			);
			selectors.set(view, selector);
		}
		return selector;
	};
}

export const sessionMessagesFamily = sessionField("messages");
export const sessionTranscriptStateFamily = sessionField("transcript");
export const dismissedVoiceSettingsRequestFamily = sessionField("dismissedVoiceSettingsRequest");
export const sessionToolExecutionsFamily = sessionField("toolExecutions");
export const sessionBusyFamily = sessionField("busy");
export const sessionSummarizationRetryFamily = sessionField("summarizationRetry");
export const sessionAutoRetryFamily = sessionField("autoRetry");
export const sessionQueueFamily = sessionField("queue");
export const sessionErrorFamily = sessionField("error");
export const sessionErrorMessageFamily = sessionField("errorMessage");
export const commandCatalogSnapshotFamily = sessionField("commandCatalog");
export const extensionUiSnapshotFamily = sessionField("extensionUi");
