import type { SendMessageRequest } from "./session";
import type { BoundedJson, BoundedJsonObject } from "./bounded-json";
import type { PiToolOrigin } from "./pi-tool-origin";
import { z } from "zod";

export const generationDurationMsSchema = z.number().positive();

export type ImageAttachment = NonNullable<SendMessageRequest["images"]>[number];

/** Address of one image inside a persisted session entry. */
export interface SessionImageSource {
	entryId: string;
	/** Index of the image part inside the entry's content array. */
	index: number;
}

interface TextContentPart {
	type: "text";
	text: string;
}

/**
 * A displayed image. Persisted messages carry `source` — the address of the image inside the
 * session store — and the renderer turns it into a authenticated `/api/media/attachment` URL, so the bytes
 * never travel inside the message. `data` is the inline fallback for a message that has not been
 * persisted yet and therefore has no address; it is replaced by `source` on the next projection.
 */
interface ImageContentPart {
	type: "image";
	mimeType: string;
	data?: string;
	source?: SessionImageSource;
}

interface ThinkingContentPart {
	type: "thinking";
	thinking: string;
}

interface ToolCallContentPart {
	type: "toolCall";
	id: string;
	name: string;
	arguments?: BoundedJsonObject;
	rendered?: RenderedTextSnapshot;
}

export type UserContentPart = TextContentPart | ImageContentPart;
export type AssistantContentPart = TextContentPart | ThinkingContentPart | ToolCallContentPart;
export type ToolResultContentPart = TextContentPart | ImageContentPart;

export interface AssistantUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: { total: number };
}

interface SessionMessageIdentity {
	/** Generation-scoped live row identity. */
	id: string;
	/** Durable Pi session entry identity, scoped by SessionRef. */
	entryId: string | null;
	/** Display/diagnostic time only. Ordering and dedupe use runtime sequence and message identity. */
	occurredAt: number;
}

export interface UserSessionMessage extends SessionMessageIdentity {
	role: "user";
	content: string | UserContentPart[];
	timestamp?: number;
}

export interface AssistantSessionMessage extends SessionMessageIdentity {
	role: "assistant";
	content: AssistantContentPart[];
	usage: AssistantUsage;
	/** First output delta to completion, excluding request latency and tool execution. Absent for unmeasured history. */
	generationDurationMs?: number;
	timestamp?: number;
	stopReason?: string;
	rawStopReason?: string;
	errorMessage?: string;
	provider?: string;
	model?: string;
}

export interface ToolResultSessionMessage extends SessionMessageIdentity {
	role: "toolResult";
	/** Deferred history carries identity/status only; content is fetched when its disclosure opens. Absence means complete. */
	contentState?: "deferred";
	content: ToolResultContentPart[];
	toolCallId: string;
	toolName: string;
	/** Persisted execution provenance. Absence means the original extension cannot be established. */
	toolOrigin?: PiToolOrigin;
	isError: boolean;
	rendered?: RenderedTextSnapshot;
	/** Provider usage reported by SDK-backed tools, when the tool performed a billed model call. */
	usage?: AssistantUsage;
	details?: BoundedJson;
	timestamp?: number;
}

export interface CompactionSummarySessionMessage extends SessionMessageIdentity {
	role: "compactionSummary";
	summary: string;
	tokensBefore: number;
	/** Usage of the model call(s) that generated this summary. */
	usage?: AssistantUsage;
	timestamp: number;
}

export interface BranchSummarySessionMessage extends SessionMessageIdentity {
	role: "branchSummary";
	summary: string;
	fromId: string | null;
	/** Usage of the model call that generated this branch summary. */
	usage?: AssistantUsage;
	timestamp: number;
}

export interface ModelChangeSessionMessage extends SessionMessageIdentity {
	role: "modelChange";
	provider: string;
	modelId: string;
	timestamp: number;
}

export interface CustomSessionMessage extends SessionMessageIdentity {
	role: "custom";
	customType: string;
	content: string | UserContentPart[];
	display: boolean;
	details?: BoundedJson;
	rendered?: RenderedCustomSessionMessage;
	timestamp?: number;
}

export interface RenderedTextSnapshot {
	collapsedLines?: string[];
	expandedLines?: string[];
	error?: string;
}

export type RenderedCustomSessionMessage = RenderedTextSnapshot;

interface UnknownSessionMessage extends SessionMessageIdentity {
	role: "unknown";
	originalRole: string;
	data: BoundedJsonObject;
}

export type SessionMessage =
	| UserSessionMessage
	| AssistantSessionMessage
	| ToolResultSessionMessage
	| CompactionSummarySessionMessage
	| BranchSummarySessionMessage
	| ModelChangeSessionMessage
	| CustomSessionMessage
	| UnknownSessionMessage;
