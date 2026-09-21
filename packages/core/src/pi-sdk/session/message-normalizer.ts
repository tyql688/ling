import { questionAnswerText } from "./question-answer-message";
import { record } from "@ling/contracts/records";
import { piToolOriginSchema } from "@ling/contracts/pi-tool-origin";
import { generationDurationMsSchema } from "@ling/contracts/session-messages";
import {
	type AssistantContentPart,
	type AssistantSessionMessage,
	type AssistantUsage,
	type BoundedJson,
	type BranchSummarySessionMessage,
	type CompactionSummarySessionMessage,
	type CustomSessionMessage,
	type ModelChangeSessionMessage,
	type RenderedCustomSessionMessage,
	SESSION_IMAGE_MIME_TYPES,
	SESSION_IMAGE_SEND_BASE64_MAX_CHARS,
	type SessionMessage,
	type ToolResultContentPart,
	type ToolResultSessionMessage,
	type UserContentPart,
	type UserSessionMessage,
} from "@ling/contracts/session";

/** Max traversal depth during normalization; 6 covers common nested content, deeper shapes are truncated as suspected cycles/malicious nesting. */
const MAX_DEPTH = 6;
/** Max nodes visited per normalization; 1K keeps oversized tool payloads from stalling the main process. */
const MAX_NODES = 1_024;
/** Max keys per object; 256 covers normal metadata, anything more is treated as an abnormal structure. */
const MAX_KEYS = 256;
/** Max array items; 512 balances tool lists against IPC size. */
const MAX_ARRAY_ITEMS = 512;
/** General string truncation limit (64Ki); longer bodies gain no interactive value in the timeline. */
const MAX_STRING_LENGTH = 64 * 1024;
/** Limit for id/name-like fields; 512 covers model ids and entry ids. */
const MAX_ID_LENGTH = 512;
/** BoundedJson serialization byte budget (512Ki); stops arbitrary JSON fields from bloating a message. */
const MAX_BOUNDED_JSON_BYTES = 512 * 1024;
/** Total byte limit per normalized message (6MiB); multi-image messages stay manageable, oversized ones are truncated/degraded. */
const MAX_NORMALIZED_MESSAGE_BYTES = 6 * 1024 * 1024;
/**
 * Reserve for everything a message carries besides its content parts (bounded details, rendered
 * lines, ids, usage, JSON framing): the content budget sits this far below the whole-message
 * limit so admitted images plus text can never alone trip the final byte check.
 */
const MESSAGE_CONTENT_RESERVE_BYTES = 576 * 1024;
/** Byte budget shared by the content parts (text + images) of one normalized message. */
const MESSAGE_CONTENT_BUDGET_BYTES = MAX_NORMALIZED_MESSAGE_BYTES - MESSAGE_CONTENT_RESERVE_BYTES;
/** Suffix marking text truncated to fit the content budget. */
const TEXT_TRUNCATION_SUFFIX = "\n[truncated]";
/** Image MIME types allowed through; shares its closed set with the shared session contract. */
const IMAGE_MIME_TYPES = new Set<string>(SESSION_IMAGE_MIME_TYPES);

interface JsonBudget {
	nodes: number;
	bytes: number;
	exhausted: boolean;
	seen: WeakSet<object>;
}

interface NormalizePiMessageOptions {
	messageId: string;
	entryId: string | null;
	occurredAt: number;
}

// Field upper bounds are defensive truncations: id/name-like 256, model id 512, role 128,
// matching the shared contract's display budget; out-of-bound values are truncated, never
// reported as errors (friendly to unknown future shapes).
function boundedString(value: string, max = MAX_STRING_LENGTH): string {
	if (value.length <= max) return value;
	return `${value.slice(0, max)}${TEXT_TRUNCATION_SUFFIX}`;
}

function safeString(value: unknown, fallback: string, max = MAX_STRING_LENGTH): string {
	return typeof value === "string" ? boundedString(value, max) : fallback;
}

function boundedJsonString(value: string, budget: JsonBudget, max = MAX_STRING_LENGTH): string {
	if (budget.exhausted) return "[byte limit exceeded]";
	const normalized = boundedString(value, max);
	const bytes = Buffer.byteLength(normalized, "utf8");
	if (budget.bytes + bytes > MAX_BOUNDED_JSON_BYTES) {
		budget.exhausted = true;
		return "[byte limit exceeded]";
	}
	budget.bytes += bytes;
	return normalized;
}

function nonNegativeFiniteNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function nonNegativeSafeInteger(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function observationTime(value: number): number {
	if (nonNegativeSafeInteger(value) === null)
		throw new Error("Pi message observation time must be a non-negative safe integer");
	return value;
}

function toBoundedJsonValue(value: unknown, budget: JsonBudget, depth: number): BoundedJson {
	budget.nodes += 1;
	if (budget.nodes > MAX_NODES) return "[node limit exceeded]";
	if (budget.exhausted) return "[byte limit exceeded]";
	if (value === null || typeof value === "boolean") return value;
	if (typeof value === "string") return boundedJsonString(value, budget);
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value !== "object") return `[unsupported ${typeof value}]`;
	if (depth >= MAX_DEPTH) return "[depth limit exceeded]";
	if (budget.seen.has(value)) return "[circular]";
	budget.seen.add(value);
	try {
		if (Array.isArray(value)) {
			return value.slice(0, MAX_ARRAY_ITEMS).map((item) => toBoundedJsonValue(item, budget, depth + 1));
		}
		const result: Record<string, BoundedJson> = {};
		for (const [key, item] of Object.entries(value).slice(0, MAX_KEYS)) {
			result[boundedJsonString(key, budget, 256)] = toBoundedJsonValue(item, budget, depth + 1);
		}
		return result;
	} finally {
		budget.seen.delete(value);
	}
}

function toBoundedJson(value: unknown): BoundedJson {
	try {
		return toBoundedJsonValue(value, { nodes: 0, bytes: 0, exhausted: false, seen: new WeakSet<object>() }, 0);
	} catch {
		return "[unserializable value]";
	}
}

type ContentPart = UserContentPart | ToolResultContentPart;
type ImageContentPart = Extract<ContentPart, { type: "image" }>;

/** Shared byte budget while normalizing one message's content parts (text + images). */
interface ContentBudget {
	remainingBytes: number;
	/** Valid images skipped because the budget ran out; reported as one aggregated note. */
	omittedImages: number;
}

function createContentBudget(): ContentBudget {
	return { remainingBytes: MESSAGE_CONTENT_BUDGET_BYTES, omittedImages: 0 };
}

/** An image part that already carries its address, from a message being normalized a second time
 * (a custom renderer re-runs normalization over its own output). It has no `data` to re-admit, so
 * matching it here is what keeps the picture from being dropped on that pass. */
function addressedImagePart(part: Record<string, unknown>): ImageContentPart | null {
	if (part.type !== "image" || typeof part.mimeType !== "string") return null;
	const source = part.source;
	if (typeof source !== "object" || source === null) return null;
	const { entryId, index } = source as { entryId?: unknown; index?: unknown };
	if (typeof entryId !== "string" || typeof index !== "number") return null;
	return { type: "image", mimeType: part.mimeType, source: { entryId, index } };
}

/** Parses an admissible image part (supported MIME, string data); null for non-image parts,
 * missing data, or unsupported MIME. */
function normalizeImagePart(part: Record<string, unknown>): { data: string; mimeType: string } | null {
	if (part.type !== "image" || typeof part.data !== "string") return null;
	const mimeType = typeof part.mimeType === "string" ? part.mimeType : part.mediaType;
	return typeof mimeType === "string" && IMAGE_MIME_TYPES.has(mimeType) ? { data: part.data, mimeType } : null;
}

/** Charges an image's base64 against the budget (base64 is ASCII, so chars == UTF-8 bytes);
 * returns null when the image no longer fits. Only unpersisted messages take this path. */
function admitImage(image: { data: string; mimeType: string }, budget: ContentBudget): ImageContentPart | null {
	if (image.data.length > budget.remainingBytes) return null;
	budget.remainingBytes -= image.data.length;
	return { type: "image", data: image.data, mimeType: image.mimeType };
}

/**
 * Emits the image as an address into the session store rather than as bytes, so a message with
 * several megabytes of attachments still projects to a few hundred bytes and the renderer fetches
 * each picture through the authenticated `/api/media/attachment` route only when it draws it. `index` is
 * the position in the source content array, which the session store reader uses verbatim.
 */
function addressedImage(mimeType: string, entryId: string, index: number): ImageContentPart {
	return { type: "image", mimeType, source: { entryId, index } };
}

/** One aggregated note for images skipped due to the budget, so a dropped payload is never silent. */
function appendImageOmissionNote(parts: ContentPart[], budget: ContentBudget): void {
	if (budget.omittedImages === 0) return;
	const label = budget.omittedImages === 1 ? "image" : "images";
	parts.push({ type: "text", text: `[${budget.omittedImages} ${label} omitted: message size limit]` });
}

/** Cuts `value` to fit within `maxBytes` UTF-8 bytes, keeping the truncation suffix;
 * returns "" when not even the suffix fits. */
function truncateTextToBytes(value: string, maxBytes: number): string {
	const suffixBytes = Buffer.byteLength(TEXT_TRUNCATION_SUFFIX, "utf8");
	if (maxBytes <= suffixBytes) return "";
	const prefixBudget = maxBytes - suffixBytes;
	let lower = 0;
	let upper = value.length;
	while (lower < upper) {
		const midpoint = Math.ceil((lower + upper) / 2);
		if (Buffer.byteLength(value.slice(0, midpoint), "utf8") <= prefixBudget) lower = midpoint;
		else upper = midpoint - 1;
	}
	return `${value.slice(0, lower)}${TEXT_TRUNCATION_SUFFIX}`;
}

/** Applies the per-part cap first, then fits the text into the remaining content budget. */
function budgetedText(value: string, budget: ContentBudget): string {
	const capped = boundedString(value);
	const bytes = Buffer.byteLength(capped, "utf8");
	if (bytes <= budget.remainingBytes) {
		budget.remainingBytes -= bytes;
		return capped;
	}
	const fitted = truncateTextToBytes(capped, budget.remainingBytes);
	if (fitted.length > 0) budget.remainingBytes -= Buffer.byteLength(fitted, "utf8");
	return fitted;
}

function normalizeUserContent(value: unknown, entryId: string | null): string | UserContentPart[] | null {
	if (typeof value === "string") return boundedString(value);
	if (!Array.isArray(value)) return null;
	const budget = createContentBudget();
	const parts: UserContentPart[] = [];
	for (const [index, candidate] of value.slice(0, MAX_ARRAY_ITEMS).entries()) {
		const part = record(candidate);
		if (!part) continue;
		if (part.type === "text" && typeof part.text === "string") {
			const text = budgetedText(part.text, budget);
			if (text.length > 0) parts.push({ type: "text", text });
			continue;
		}
		const addressed = addressedImagePart(part);
		if (addressed) {
			parts.push(addressed);
			continue;
		}
		const image = normalizeImagePart(part);
		if (image === null) {
			if (part.type === "image" && typeof part.data === "string") {
				parts.push({ type: "text", text: "[unsupported image omitted]" });
			}
			continue;
		}
		// The send cap stays for user attachments: it mirrors the provider rejection threshold,
		// and the send path already downscaled anything larger than it.
		if (image.data.length > SESSION_IMAGE_SEND_BASE64_MAX_CHARS) {
			parts.push({ type: "text", text: `[oversized ${image.mimeType} image omitted]` });
			continue;
		}
		if (entryId !== null) {
			parts.push(addressedImage(image.mimeType, entryId, index));
			continue;
		}
		const admitted = admitImage(image, budget);
		if (admitted) parts.push(admitted);
		else budget.omittedImages += 1;
	}
	appendImageOmissionNote(parts, budget);
	return parts;
}

function normalizeAssistantContent(value: unknown): AssistantContentPart[] | null {
	if (!Array.isArray(value)) return null;
	const parts: AssistantContentPart[] = [];
	for (const candidate of value.slice(0, MAX_ARRAY_ITEMS)) {
		const part = record(candidate);
		if (!part) continue;
		if (part.type === "text" && typeof part.text === "string") {
			parts.push({ type: "text", text: boundedString(part.text) });
		} else if (part.type === "thinking" && typeof part.thinking === "string") {
			parts.push({ type: "thinking", thinking: boundedString(part.thinking) });
		} else if (part.type === "toolCall" && typeof part.id === "string" && typeof part.name === "string") {
			const argumentsValue = toBoundedJson(part.arguments);
			const rendered = normalizeRendered(part.rendered);
			parts.push({
				type: "toolCall",
				id: boundedString(part.id, MAX_ID_LENGTH),
				name: boundedString(part.name, 256),
				...(argumentsValue && typeof argumentsValue === "object" && !Array.isArray(argumentsValue)
					? { arguments: argumentsValue }
					: {}),
				...(rendered ? { rendered } : {}),
			});
		} else {
			parts.push({ type: "text", text: `[unsupported assistant content: ${safeString(part.type, "unknown", 64)}]` });
		}
	}
	return parts;
}

function normalizeToolResultContent(value: unknown, entryId: string | null): ToolResultContentPart[] | null {
	if (!Array.isArray(value)) return null;
	const budget = createContentBudget();
	const parts: ToolResultContentPart[] = [];
	const textParts: string[] = [];
	for (const [index, candidate] of value.slice(0, MAX_ARRAY_ITEMS).entries()) {
		const part = record(candidate);
		if (!part) continue;
		if (part.type === "text" && typeof part.text === "string") {
			textParts.push(part.text);
			continue;
		}
		const addressed = addressedImagePart(part);
		if (addressed) {
			parts.push(addressed);
			continue;
		}
		const image = normalizeImagePart(part);
		if (image === null) {
			if (part.type === "image" && typeof part.data === "string") {
				parts.push({ type: "text", text: "[unsupported image omitted]" });
			}
			continue;
		}
		if (entryId !== null) {
			parts.push(addressedImage(image.mimeType, entryId, index));
			continue;
		}
		// Display-only: no provider send limit applies, so the content budget is the only cap.
		// Images are admitted first — a read on a PNG pairs a stub text label with the real
		// payload in the image part — and text then fits into the remainder.
		const admitted = admitImage(image, budget);
		if (admitted) parts.push(admitted);
		else budget.omittedImages += 1;
	}
	for (const text of textParts) {
		const fitted = budgetedText(text, budget);
		if (fitted.length > 0) parts.push({ type: "text", text: fitted });
	}
	appendImageOmissionNote(parts, budget);
	return parts;
}

function normalizeUsage(value: unknown): AssistantUsage | null {
	const source = record(value);
	const cost = record(source?.cost);
	const input = nonNegativeSafeInteger(source?.input);
	const output = nonNegativeSafeInteger(source?.output);
	const cacheRead = nonNegativeSafeInteger(source?.cacheRead);
	const cacheWrite = nonNegativeSafeInteger(source?.cacheWrite);
	const totalTokens = nonNegativeSafeInteger(source?.totalTokens);
	const totalCost = nonNegativeFiniteNumber(cost?.total);
	if ([input, output, cacheRead, cacheWrite, totalTokens, totalCost].some((item) => item === null)) return null;
	return {
		input: input as number,
		output: output as number,
		cacheRead: cacheRead as number,
		cacheWrite: cacheWrite as number,
		totalTokens: totalTokens as number,
		cost: { total: totalCost as number },
	};
}

function normalizeRendered(value: unknown): RenderedCustomSessionMessage | undefined {
	const source = record(value);
	if (!source) return undefined;
	const collapsedLines = Array.isArray(source.collapsedLines)
		? source.collapsedLines.filter((line): line is string => typeof line === "string").slice(0, MAX_ARRAY_ITEMS)
		: undefined;
	const expandedLines = Array.isArray(source.expandedLines)
		? source.expandedLines.filter((line): line is string => typeof line === "string").slice(0, MAX_ARRAY_ITEMS)
		: undefined;
	const error = typeof source.error === "string" ? boundedString(source.error) : undefined;
	return {
		...(collapsedLines ? { collapsedLines: collapsedLines.map((line) => boundedString(line)) } : {}),
		...(expandedLines ? { expandedLines: expandedLines.map((line) => boundedString(line)) } : {}),
		...(error ? { error } : {}),
	};
}

function messageTime(source: Record<string, unknown>, fallback: number): number {
	return nonNegativeSafeInteger(source.timestamp) ?? fallback;
}

function identity(options: NormalizePiMessageOptions, occurredAt: number) {
	return {
		id: boundedString(options.messageId, MAX_ID_LENGTH),
		entryId: options.entryId === null ? null : boundedString(options.entryId, MAX_ID_LENGTH),
		occurredAt,
	};
}

function unknownMessage(source: Record<string, unknown>, options: NormalizePiMessageOptions): SessionMessage {
	const originalRole = safeString(source.role, "unknown", 128);
	const details = toBoundedJson(source);
	return {
		role: "unknown",
		...identity(options, options.occurredAt),
		originalRole,
		data: details && typeof details === "object" && !Array.isArray(details) ? details : { value: details },
	};
}

function normalizePiMessageValue(value: unknown, options: NormalizePiMessageOptions): SessionMessage {
	const source = record(value);
	if (!source) return unknownMessage({ role: "invalid", value }, options);
	const occurredAt = messageTime(source, options.occurredAt);
	const messageIdentity = identity(options, occurredAt);

	if (source.role === "user") {
		const content = normalizeUserContent(source.content, messageIdentity.entryId);
		if (content === null) return unknownMessage(source, { ...options, occurredAt });
		return { ...messageIdentity, role: "user", content, timestamp: occurredAt } satisfies UserSessionMessage;
	}
	if (source.role === "assistant") {
		const content = normalizeAssistantContent(source.content);
		const usage = normalizeUsage(source.usage);
		if (!content || !usage) return unknownMessage(source, { ...options, occurredAt });
		return {
			...messageIdentity,
			role: "assistant",
			content,
			usage,
			...(source.generationDurationMs === undefined
				? {}
				: { generationDurationMs: generationDurationMsSchema.parse(source.generationDurationMs) }),
			timestamp: occurredAt,
			...(typeof source.stopReason === "string" ? { stopReason: boundedString(source.stopReason, 128) } : {}),
			...(typeof source.rawStopReason === "string" ? { rawStopReason: boundedString(source.rawStopReason, 128) } : {}),
			...(typeof source.errorMessage === "string" ? { errorMessage: boundedString(source.errorMessage) } : {}),
			...(typeof source.provider === "string" ? { provider: boundedString(source.provider, 256) } : {}),
			...(typeof source.model === "string" ? { model: boundedString(source.model, 512) } : {}),
		} satisfies AssistantSessionMessage;
	}
	if (source.role === "toolResult") {
		const content = normalizeToolResultContent(source.content, messageIdentity.entryId);
		const usage = source.usage === undefined ? undefined : normalizeUsage(source.usage);
		if (
			!content ||
			typeof source.toolCallId !== "string" ||
			typeof source.toolName !== "string" ||
			typeof source.isError !== "boolean" ||
			(source.usage !== undefined && !usage)
		) {
			return unknownMessage(source, { ...options, occurredAt });
		}
		const rendered = normalizeRendered(source.rendered);
		return {
			...messageIdentity,
			role: "toolResult",
			...(source.contentState === "deferred" ? { contentState: "deferred" as const } : {}),
			content,
			toolCallId: boundedString(source.toolCallId, MAX_ID_LENGTH),
			toolName: boundedString(source.toolName, 256),
			...(source.toolOrigin === undefined ? {} : { toolOrigin: piToolOriginSchema.parse(source.toolOrigin) }),
			isError: source.isError,
			...(rendered ? { rendered } : {}),
			...(usage ? { usage } : {}),
			...(source.details === undefined ? {} : { details: toBoundedJson(source.details) }),
			timestamp: occurredAt,
		} satisfies ToolResultSessionMessage;
	}
	if (source.role === "custom") {
		const content = normalizeUserContent(source.content, messageIdentity.entryId);
		if (typeof source.customType !== "string" || content === null) {
			return unknownMessage(source, { ...options, occurredAt });
		}
		// Pi converts this durable custom envelope to a user message for the model too.
		if (questionAnswerText(source) !== null) {
			return { ...messageIdentity, role: "user", content, timestamp: occurredAt } satisfies UserSessionMessage;
		}

		const rendered = normalizeRendered(source.rendered);
		return {
			...messageIdentity,
			role: "custom",
			customType: boundedString(source.customType, 256),
			content,
			display: source.display === true,
			...(source.details === undefined ? {} : { details: toBoundedJson(source.details) }),
			...(rendered ? { rendered } : {}),
			timestamp: occurredAt,
		} satisfies CustomSessionMessage;
	}
	if (source.role === "compactionSummary") {
		const tokensBefore = nonNegativeSafeInteger(source.tokensBefore);
		const usage = source.usage === undefined ? undefined : normalizeUsage(source.usage);
		if (typeof source.summary !== "string" || tokensBefore === null || (source.usage !== undefined && !usage)) {
			return unknownMessage(source, { ...options, occurredAt });
		}
		return {
			...messageIdentity,
			role: "compactionSummary",
			summary: boundedString(source.summary),
			tokensBefore,
			...(usage ? { usage } : {}),
			timestamp: occurredAt,
		} satisfies CompactionSummarySessionMessage;
	}
	if (source.role === "branchSummary") {
		const usage = source.usage === undefined ? undefined : normalizeUsage(source.usage);
		if (
			typeof source.summary !== "string" ||
			(source.fromId !== null && typeof source.fromId !== "string") ||
			(source.usage !== undefined && !usage)
		) {
			return unknownMessage(source, { ...options, occurredAt });
		}
		return {
			...messageIdentity,
			role: "branchSummary",
			summary: boundedString(source.summary),
			fromId: source.fromId === null ? null : boundedString(source.fromId, MAX_ID_LENGTH),
			...(usage ? { usage } : {}),
			timestamp: occurredAt,
		} satisfies BranchSummarySessionMessage;
	}
	if (source.role === "modelChange") {
		if (typeof source.provider !== "string" || typeof source.modelId !== "string") {
			return unknownMessage(source, { ...options, occurredAt });
		}
		return {
			...messageIdentity,
			role: "modelChange",
			provider: boundedString(source.provider, 256),
			modelId: boundedString(source.modelId, 512),
			timestamp: occurredAt,
		} satisfies ModelChangeSessionMessage;
	}
	return unknownMessage(source, { ...options, occurredAt });
}

export function normalizePiMessage(value: unknown, options: NormalizePiMessageOptions): SessionMessage {
	observationTime(options.occurredAt);
	try {
		const message = normalizePiMessageValue(value, options);
		const byteLength = Buffer.byteLength(JSON.stringify(message), "utf8");
		if (byteLength <= MAX_NORMALIZED_MESSAGE_BYTES) return message;
		return {
			role: "unknown",
			id: message.id,
			entryId: message.entryId,
			occurredAt: message.occurredAt,
			originalRole: message.role === "unknown" ? message.originalRole : message.role,
			data: {
				error: "normalized message exceeded byte limit",
				byteLength,
				maxBytes: MAX_NORMALIZED_MESSAGE_BYTES,
			},
		};
	} catch {
		return unknownMessage({ role: "unreadable", error: "Message normalization failed" }, options);
	}
}
