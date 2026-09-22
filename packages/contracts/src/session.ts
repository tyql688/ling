import { z } from "zod";
import type { SessionMessageDelta } from "./session-message-delta";
import type * as requestSchemas from "./session-requests";
import type { ToolExecutionProgress } from "./session-tool-progress";
type RequestSchemasShape = ReturnType<typeof requestSchemas.createSessionRequestSchemas>;

import type { DatasetStoreStatus } from "./dataset-status";
import type { MessageFileReference } from "./file-reference-text";
import type { PiDiagnostic } from "./pi-diagnostic";
import type { ExtensionUiStateSnapshot } from "./session-extension-ui";
import type { CompactionSummarySessionMessage, ImageAttachment, SessionMessage } from "./session-messages";
import type { SessionRef } from "./session-ref";

export type { BoundedJson } from "./bounded-json";
export {
	EMPTY_EXTENSION_UI_STATE,
	EXTENSION_AUTOCOMPLETE_DESCRIPTION_MAX_CHARS,
	EXTENSION_AUTOCOMPLETE_LABEL_MAX_CHARS,
	EXTENSION_AUTOCOMPLETE_MAX_ITEMS,
	EXTENSION_AUTOCOMPLETE_MAX_LINES,
	EXTENSION_AUTOCOMPLETE_TOTAL_MAX_CHARS,
	EXTENSION_UI_INPUT_MAX_CHARS,
	EXTENSION_UI_KEY_MAX_CHARS,
	EXTENSION_UI_RENDERED_LINE_MAX_ITEMS,
	EXTENSION_UI_STATE_COLLECTION_MAX_ITEMS,
	EXTENSION_UI_TEXT_MAX_CHARS,
	EXTENSION_UI_WORKING_FRAME_MAX_ITEMS,
} from "./session-extension-ui";
export type {
	ApplyExtensionAutocompleteRequest,
	ApplyExtensionAutocompleteResult,
	ExtensionAutocompleteItem,
	ExtensionAutocompleteRequest,
	ExtensionAutocompleteSuggestions,
	ExtensionTerminalInputReplayRequest,
	ExtensionTerminalInputResult,
	ExtensionUiStateEvent,
	ExtensionUiStateSnapshot,
	SessionCommandArgumentCompletionRequest,
	SessionRuntimeBindingRequest,
} from "./session-extension-ui";
export type {
	AssistantContentPart,
	AssistantSessionMessage,
	AssistantUsage,
	BranchSummarySessionMessage,
	CompactionSummarySessionMessage,
	CustomSessionMessage,
	ImageAttachment,
	ModelChangeSessionMessage,
	RenderedCustomSessionMessage,
	RenderedTextSnapshot,
	SessionImageSource,
	SessionMessage,
	ToolResultContentPart,
	ToolResultSessionMessage,
	UserContentPart,
	UserSessionMessage,
} from "./session-messages";
export type { SessionRef } from "./session-ref";

/** Thinking-level closed set (shallow → deep), aligned with Pi capabilities; the selector renders in this order and free strings are rejected. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export type SendMode = "prompt" | "steer" | "followUp";

// These are retained renderer inputs and IPC payloads. Sharing the limits keeps
// every admitted draft/title valid at the independently validated Main boundary.
/** 1M-char cap on a single message body, shared by renderer drafts and main IPC so an unbounded prompt can't blow up cloning/persistence. */
export const SESSION_MESSAGE_TEXT_MAX_CHARS = 1_048_576;
/** 1K-char cap on a session title, shared by sidebar/list display and the rename IPC so an overlong title can't distort the UI. */
export const SESSION_TITLE_MAX_CHARS = 1_024;
// SessionSummary.preview is a command-palette search hint, not transcript data.
// 8 Ki covers the largest first message (5,456 chars) in the 2026-07-12 local
// 59-session audit while bounding every retained list/event projection.
/** 8 Ki cap on a summary preview — the command-palette search hint (not the full transcript); covers the largest local-audit first entry while bounding the list projection. */
export const SESSION_SUMMARY_PREVIEW_MAX_CHARS = 8_192;
// Main persists and returns this many deduplicated entries; Renderer retains the
// same navigation window so loaded and newly submitted history cannot diverge.
/** 100-entry composer-history cap; main persistence matches the renderer navigation window so the two histories can't drift. */
export const SESSION_COMPOSER_HISTORY_MAX_ITEMS = 100;

// The Composer and IPC sender share this count so every admitted draft is sendable.
// Byte limits bound one decoded image and the combined structured-clone payload;
// Renderer retained-data policy may impose a stricter encoded-data budget.
/** Cap on images per send, shared by the composer and IPC so a draft stays sendable while bounding attachment fan-out. */
export const SESSION_IMAGE_MAX_ITEMS = 10;
/** 16 MiB cap on a single decoded image, bounding per-attachment structured-clone cost (drafts/IPC may briefly hold larger images). */
export const SESSION_IMAGE_MAX_BYTES = 16 * 1_024 * 1_024;
/** 32 MiB cap on total images per send; bounds the combined payload — the renderer encoding policy may be stricter. */
export const SESSION_IMAGE_TOTAL_MAX_BYTES = 32 * 1_024 * 1_024;
/** Pi owns image format conversion; this boundary only admits an image media type. */
export const sessionImageMimeTypeSchema = z
	.string()
	.max(128)
	.regex(/^image\/[a-zA-Z0-9.+-]+$/);

export type RunOutcome =
	| { status: "success" }
	| { status: "cancelled" }
	| {
			status: "failed";
			message: string;
			code?: string;
			/** Queued steer/follow-up messages Ling held back from the failing run, for the composer to restore. */
			restoredMessages?: readonly SessionQueuedMessage[];
	  };

export type SummarizationRetryStatus =
	| {
			phase: "waiting";
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			errorMessage: string;
	  }
	| { phase: "running"; source: "branchSummary" }
	| { phase: "running"; source: "compaction"; reason: "manual" | "threshold" | "overflow" };

/** Pi's automatic provider-error retry of the current agent turn (auto_retry_start/end). */
export interface AutoRetryStatus {
	attempt: number;
	maxAttempts: number;
	delayMs: number;
	errorMessage: string;
}

export type LingSessionEvent =
	| SessionMessageDelta
	| { type: "toolExecutionChanged"; toolCallId: string; progress: ToolExecutionProgress | null }
	| { type: "messageStart"; message: SessionMessage }
	| { type: "messageUpdate"; message: SessionMessage; streamMode?: "full" }
	| { type: "messageEnd"; message: SessionMessage }
	| { type: "messagePersisted"; messageId: string; entryId: string }
	| { type: "turnEnd"; message: SessionMessage }
	| { type: "compactionSummary"; message: CompactionSummarySessionMessage }
	| {
			type: "transcriptInvalidated";
			reason: "compaction" | "treeNavigation" | "reload";
	  }
	| { type: "queueChanged"; queue: SessionQueue }
	| { type: "runStarted"; runId: string; timestamp: number }
	| { type: "runFinished"; runId: string; outcome: RunOutcome; timestamp: number }
	| { type: "summarizationRetryChanged"; status: SummarizationRetryStatus | null }
	| { type: "autoRetryChanged"; status: AutoRetryStatus | null }
	| { type: "commandsChanged"; revision: number }
	| { type: "extensionUiChanged"; revision: number }
	| { type: "sessionSummaryChanged"; summary: SessionSummary }
	| { type: "sessionCatalogChanged"; reason: "replacement" | "external" }
	| { type: "sessionReplaced"; previousRef: SessionRef; reason: "new" | "fork" | "switch" | "refresh" }
	| { type: "snapshotChanged" }
	| { type: "transcriptProjectionChanged"; reason: "markdownWidth" }
	| { type: "activity"; id: string; text: string; tone?: "normal" | "error" };

type SessionRelationSource = "subagent" | "workflow" | "plugin" | "unknown";
type SessionRelationConfidence = "strong" | "medium" | "weak";

export type SessionRelation =
	| {
			kind: "manualFork";
			parentRef: SessionRef;
			parentSessionFilePath: string;
	  }
	| {
			kind: "child";
			parentRef: SessionRef;
			parentSessionFilePath: string;
			source: SessionRelationSource;
			confidence: SessionRelationConfidence;
			reason: string;
	  };

export interface SessionSummary {
	id: string;
	cwd: string;
	title: string;
	createdAt: number;
	/** Latest user/assistant message or session creation timestamp, whichever is later. */
	updatedAt: number;
	messageCount: number;
	preview: string;
	archivedAt?: number;
	pinnedAt?: number;
	relation?: SessionRelation;
}

/**
 * A subagent/child session linked to its parent through the SDK session model
 * (the `parentSession` header field; see `core/session-relations.ts`). Surfaced
 * read-only: Ling lists these and opens their transcripts. It deliberately does
 * NOT model live run state or control actions — those are specific to whichever
 * third-party subagent plugin produced the session, and a persisted session file
 * cannot report whether a run is still active. Stopping a run is done through the
 * parent turn's own abort, which cascades to in-process subagents.
 */
export type SetSessionArchivedRequest = z.infer<RequestSchemasShape["setSessionArchivedRequestSchema"]>;

export type SetSessionPinnedRequest = z.infer<RequestSchemasShape["setSessionPinnedRequestSchema"]>;

export interface ModelInfo {
	provider: string;
	providerName: string;
	id: string;
	name: string;
	reasoning: boolean;
	/** Pi-supported levels after applying the model's thinkingLevelMap. */
	availableThinkingLevels: ThinkingLevel[];
	contextWindow: number;
}

export interface ModelState {
	models: ModelInfo[];
	currentProvider?: string;
	currentModelId?: string;
	thinkingLevel: ThinkingLevel;
	availableThinkingLevels: ThinkingLevel[];
}

interface SessionResourceReloadFailure {
	ref: SessionRef;
	message: string;
}

/** Sample cap for resource-reload failure diagnostics: the full list can be large, so only a sample plus failedOmitted is kept. */
export const SESSION_RESOURCE_RELOAD_MAX_FAILURES = 32;
/** Per-failure message cap for reload diagnostics: bounds the field so an abnormal error string can't blow up the summary DTO. */
export const SESSION_RESOURCE_RELOAD_FAILURE_MAX_CHARS = 2_048;

/** Result of applying one canonical package/skill/settings/model revision to live sessions. */
export interface SessionResourceReloadSummary {
	revision: number;
	reloaded: number;
	deferred: number;
	failed: SessionResourceReloadFailure[];
	/** Failures beyond the bounded `failed` diagnostic sample. */
	failedOmitted: number;
}

/** Full Pi resource reconciliation result returned after a settings/package mutation. */
export interface PiResourceReloadSummary {
	/** Project catalog reload failure; null when every open project reloaded. */
	projectError: string | null;
	/** Live session result; null only when the session coordinator itself failed. */
	sessions: SessionResourceReloadSummary | null;
	/** Coordinator-level failure, distinct from per-session failures above. */
	sessionError: string | null;
}

export interface SessionCommandCatalog {
	skills: { name: string; description: string }[];
	prompts: { name: string; description: string; argumentHint: string | null }[];
	extensions: { name: string; description: string | null; hasArgumentCompletions: boolean }[];
}

export type ReadSessionCompanionRequest = z.infer<RequestSchemasShape["readSessionCompanionRequestSchema"]>;

export interface RuntimeCommandCatalogSnapshot {
	protocolVersion: 1;
	runtimeId: string;
	generation: number;
	ref: SessionRef;
	revision: number;
	catalog: SessionCommandCatalog;
}

export interface RuntimeExtensionUiSnapshot {
	protocolVersion: 1;
	runtimeId: string;
	generation: number;
	ref: SessionRef;
	revision: number;
	state: ExtensionUiStateSnapshot;
}

export interface SessionQueuedMessage {
	/** Question answers retain their original envelope and cannot be edited as ordinary drafts. */
	readOnly?: boolean;
	/** Actual Pi queue text; also the stale-index identity used by mutations. */
	text: string;
	/** Composer text before Pi command/template expansion and before file-reference projection. */
	draftText: string;
	images: readonly ImageAttachment[];
	fileReferences: readonly MessageFileReference[];
}

export interface SessionQueue {
	/** Monotonic per-runtime revision. Mutations carry the revision they were rendered from so a
	 * message that dequeues during an edit cannot be mistaken for a newer queue entry. */
	revision: number;
	steering: readonly SessionQueuedMessage[];
	followUp: readonly SessionQueuedMessage[];
}

export type TranscriptPageDirection = "older" | "newer";

export interface TranscriptPage {
	protocolVersion: 1;
	runtimeId: string;
	generation: number;
	ref: SessionRef;
	transcriptRevision: number;
	items: SessionMessage[];
	limit: number;
	olderCursor?: string;
	newerCursor?: string;
	hasOlder: boolean;
	hasNewer: boolean;
}

export type ReadTranscriptPageRequest = z.infer<RequestSchemasShape["readTranscriptPageRequestSchema"]>;

export type ReadToolResultRequest = z.infer<RequestSchemasShape["readToolResultRequestSchema"]>;

export interface ReadTranscriptPageResponse {
	requestId: string;
	page: TranscriptPage;
}

export type CancelSessionOperationRequest = z.infer<RequestSchemasShape["cancelSessionOperationRequestSchema"]>;

export interface CancelSessionOperationResponse {
	requestId: string;
	accepted: boolean;
}

export interface SessionSnapshot {
	/** Live output only; cleared with the runtime generation and never persisted as history. */
	toolExecutions: readonly ToolExecutionProgress[];
	protocolVersion: 1;
	runtimeId: string;
	generation: number;
	ref: SessionRef;
	lastSequence: number;
	stateRevision: number;
	transcriptRevision: number;
	/** Stable identity of the branch, projection inputs, and loaded resources behind a complete renderer transcript. */
	transcriptCacheKey: string | null;
	commandCatalogRevision: number;
	extensionUiRevision: number;
	lifecycle: "active" | "replacing" | "disposing" | "disposed" | "failed";
	transcriptTail: TranscriptPage;
	busy: boolean;
	summarizationRetry: SummarizationRetryStatus | null;
	autoRetry: AutoRetryStatus | null;
	queue: SessionQueue;
	diagnostics: PiDiagnostic[];
}

export type SessionSnapshotRequest = z.infer<RequestSchemasShape["sessionSnapshotRequestSchema"]>;

export type CreateSessionRequest = z.infer<RequestSchemasShape["createSessionRequestSchema"]>;

export type SessionDeletionOutcome = { status: "deleted" } | { status: "deleted-with-warning"; warning: string };

/** Catalog changes also reach clients that never subscribed to the affected runtime. */
export type SessionCatalogChange = { type: "changed" } | { type: "removed"; ref: SessionRef };

export type SessionCatalogStatus =
	DatasetStoreStatus | { status: "degraded"; errorCode: "SESSION_CATALOG_PERSIST_FAILED" };

export type ResumeSessionRequest = z.infer<RequestSchemasShape["resumeSessionRequestSchema"]>;

export interface ResumeSessionResponse {
	/** Monotonic host revision used to reject a delayed suspension event for an older runtime. */
	retentionRevision: number;
}

export type SendMessageRequest = z.infer<RequestSchemasShape["sendMessageRequestSchema"]>;

export interface ComposerHistoryEntry {
	text: string;
	cwd: string;
	createdAt: number;
}

export type ListComposerHistoryRequest = z.infer<RequestSchemasShape["listComposerHistoryRequestSchema"]>;

export type ComposerHistoryStatus =
	| { status: "ready"; pendingEntries: number }
	| { status: "degraded"; errorCode: "COMPOSER_HISTORY_PERSIST_FAILED"; pendingEntries: number };

export type SetSessionModelRequest = z.infer<RequestSchemasShape["setSessionModelRequestSchema"]>;

export type SetSessionThinkingLevelRequest = z.infer<RequestSchemasShape["setSessionThinkingLevelRequestSchema"]>;

export type ForkSessionRequest = z.infer<RequestSchemasShape["forkSessionRequestSchema"]>;

/** Rewind target: the user message whose turn is being replaced. */
export type RewindSessionRequest = z.infer<RequestSchemasShape["rewindSessionRequestSchema"]>;

export type RenameSessionRequest = z.infer<RequestSchemasShape["renameSessionRequestSchema"]>;

export type CompactSessionRequest = z.infer<RequestSchemasShape["compactSessionRequestSchema"]>;

export type EditQueuedRequest = z.infer<RequestSchemasShape["editQueuedRequestSchema"]>;

export type PromoteQueuedRequest = z.infer<RequestSchemasShape["promoteQueuedRequestSchema"]>;

export type SessionEventDeliveryClass = "snapshotRecoverable" | "durableFact" | "telemetry";

export interface SessionRuntimeWatermark {
	protocolVersion: 1;
	runtimeId: string;
	generation: number;
	lastSequence: number;
	stateRevision: number;
	transcriptRevision: number;
}

export interface SessionEventEnvelope {
	protocolVersion: 1;
	runtimeId: string;
	generation: number;
	sequence: number;
	stateRevision: number;
	transcriptRevision: number;
	ref: SessionRef;
	occurredAt: number;
	deliveryClass: SessionEventDeliveryClass;
	event: LingSessionEvent;
}

export interface ApprovalRequest {
	requestId: string;
	ref: SessionRef;
	title: string;
	message: string;
	expiresAt: number | null;
}

export interface SessionTitleChangedEvent {
	ref: SessionRef;
	title: string;
}

/** Final host notification emitted after a runtime was released while its durable session remains. */
export interface SessionRuntimeSuspendedEvent {
	ref: SessionRef;
	retentionRevision: number;
	reason: "idle" | "failed";
}

/** Extension UI prompts (pi's ctx.ui.select / ctx.ui.input) bridged to GUI dialogs. */
export interface ExtensionUiRequest {
	requestId: string;
	ref: SessionRef;
	kind: "select" | "input" | "editor";
	title: string;
	options: string[];
	placeholder: string | null;
	initialValue: string | null;
	expiresAt: number | null;
}

export interface DialogDismissEvent {
	requestId: string;
}

export type ReadArchivedTranscriptRequest = z.infer<RequestSchemasShape["readArchivedTranscriptRequestSchema"]>;

/**
 * A persisted transcript read without a runtime, for a session whose project folder is gone. The
 * Pi worker response frame and the transcript item cap already bound it; a further cut here would
 * silently drop history instead of failing visibly.
 */
export interface ArchivedTranscript {
	messages: SessionMessage[];
}
