import { createMessageFileReferenceSchema } from "@ling/contracts/session-requests";
import {
	type BoundedJsonLimits,
	type BoundedJsonObject,
	boundedJsonObjectValidationError,
} from "@ling/contracts/bounded-json";
import { SESSION_IMAGE_MAX_ITEMS, sessionImageMimeTypeSchema, THINKING_LEVELS } from "@ling/contracts/session";
import { TOOL_PROGRESS_MAX_CHARS } from "@ling/contracts/session-tool-progress";
import { absolutePathSchema as createAbsolutePathSchema, nativeSessionRefSchema } from "../paths";
import { z } from "zod";
import { piToolOriginSchema } from "@ling/contracts/pi-tool-origin";
import { generationDurationMsSchema } from "@ling/contracts/session-messages";

const TRANSPORT_TEXT_MAX_CHARS = 64 * 1024 * 1024;
const FIELD_MAX_CHARS = 1_048_576;
const ID_MAX_CHARS = 4_096;
export const COLLECTION_MAX_ITEMS = 100_000;
const TRANSCRIPT_MESSAGE_MAX_ITEMS = 250_000;

const PI_WORKER_ERROR_DETAILS_LIMITS = {
	maxDepth: 6,
	maxNodes: 512,
	maxObjectKeys: 128,
	maxArrayItems: 256,
	maxKeyChars: 256,
	maxStringChars: 16_384,
	maxBytes: 64 * 1024,
} satisfies BoundedJsonLimits;

export const textSchema = z.string().max(TRANSPORT_TEXT_MAX_CHARS);
export const fieldSchema = z.string().max(FIELD_MAX_CHARS);
export const idSchema = z.string().min(1).max(ID_MAX_CHARS);
export const countSchema = z.number().int().nonnegative();
const numberSchema = z.number().nonnegative();
const timestampSchema = z.number().int().nonnegative();
export const thinkingLevelSchema = z.enum(THINKING_LEVELS);
const absolutePathSchema = createAbsolutePathSchema("Pi worker path");
// Preserve the established payload ID cap; other message IDs use the same wire bound.
export const sessionRefSchema = nativeSessionRefSchema.extend({ sessionId: idSchema });
export const imageSchema = z.strictObject({
	type: z.literal("image"),
	data: textSchema,
	mimeType: sessionImageMimeTypeSchema,
});

export const errorDetailsSchema: z.ZodType<BoundedJsonObject> = z.unknown().transform((value, context) => {
	const issue = boundedJsonObjectValidationError(value, PI_WORKER_ERROR_DETAILS_LIMITS);
	if (issue) {
		context.addIssue({ code: "custom", message: `Invalid Pi worker error details: ${issue}` });
		return z.NEVER;
	}
	return value as BoundedJsonObject;
});

const usageSchema = z.strictObject({
	input: countSchema,
	output: countSchema,
	cacheRead: countSchema,
	cacheWrite: countSchema,
	totalTokens: countSchema,
	cost: z.strictObject({ total: numberSchema }),
});

const renderedTextSchema = z.strictObject({
	collapsedLines: z.array(fieldSchema).max(COLLECTION_MAX_ITEMS).optional(),
	expandedLines: z.array(fieldSchema).max(COLLECTION_MAX_ITEMS).optional(),
	error: fieldSchema.optional(),
});

const textContentSchema = z.strictObject({ type: z.literal("text"), text: textSchema });
const thinkingContentSchema = z.strictObject({ type: z.literal("thinking"), thinking: textSchema });
const toolCallContentSchema = z.strictObject({
	type: z.literal("toolCall"),
	id: idSchema,
	name: idSchema,
	arguments: z.record(z.string().max(ID_MAX_CHARS), z.json()).optional(),
	rendered: renderedTextSchema.optional(),
});
/** Projected image parts address the session store; only unpersisted messages still inline bytes. */
const displayedImageSchema = z.strictObject({
	type: z.literal("image"),
	mimeType: sessionImageMimeTypeSchema,
	data: textSchema.optional(),
	source: z.strictObject({ entryId: idSchema, index: countSchema }).optional(),
});
const userContentSchema = z.union([textContentSchema, displayedImageSchema]);
const assistantContentSchema = z.union([textContentSchema, thinkingContentSchema, toolCallContentSchema]);
const toolResultContentSchema = z.union([textContentSchema, displayedImageSchema]);

const messageIdentityShape = {
	id: idSchema,
	entryId: idSchema.nullable(),
	occurredAt: timestampSchema,
};
const optionalMessageFields = {
	timestamp: timestampSchema.optional(),
};

export const sessionMessageSchema = z.discriminatedUnion("role", [
	z.strictObject({
		...messageIdentityShape,
		...optionalMessageFields,
		role: z.literal("user"),
		content: z.union([textSchema, z.array(userContentSchema).max(COLLECTION_MAX_ITEMS)]),
	}),
	z.strictObject({
		...messageIdentityShape,
		...optionalMessageFields,
		role: z.literal("assistant"),
		content: z.array(assistantContentSchema).max(COLLECTION_MAX_ITEMS),
		usage: usageSchema,
		generationDurationMs: generationDurationMsSchema.optional(),
		stopReason: fieldSchema.optional(),
		rawStopReason: fieldSchema.optional(),
		errorMessage: textSchema.optional(),
		provider: fieldSchema.optional(),
		model: fieldSchema.optional(),
	}),
	z.strictObject({
		...messageIdentityShape,
		...optionalMessageFields,
		role: z.literal("toolResult"),
		contentState: z.literal("deferred").optional(),
		content: z.array(toolResultContentSchema).max(COLLECTION_MAX_ITEMS),
		toolCallId: idSchema,
		toolName: idSchema,
		toolOrigin: piToolOriginSchema.optional(),
		isError: z.boolean(),
		rendered: renderedTextSchema.optional(),
		usage: usageSchema.optional(),
		details: z.json().optional(),
	}),
	z.strictObject({
		...messageIdentityShape,
		role: z.literal("compactionSummary"),
		summary: textSchema,
		tokensBefore: countSchema,
		usage: usageSchema.optional(),
		timestamp: timestampSchema,
	}),
	z.strictObject({
		...messageIdentityShape,
		role: z.literal("branchSummary"),
		summary: textSchema,
		fromId: idSchema.nullable(),
		usage: usageSchema.optional(),
		timestamp: timestampSchema,
	}),
	z.strictObject({
		...messageIdentityShape,
		role: z.literal("modelChange"),
		provider: fieldSchema,
		modelId: fieldSchema,
		timestamp: timestampSchema,
	}),
	z.strictObject({
		...messageIdentityShape,
		...optionalMessageFields,
		role: z.literal("custom"),
		customType: fieldSchema,
		content: z.union([textSchema, z.array(userContentSchema).max(COLLECTION_MAX_ITEMS)]),
		display: z.boolean(),
		details: z.json().optional(),
		rendered: renderedTextSchema.optional(),
	}),
	z.strictObject({
		...messageIdentityShape,
		role: z.literal("unknown"),
		originalRole: fieldSchema,
		data: z.record(z.string().max(ID_MAX_CHARS), z.json()),
	}),
]);

export const sessionMessagesSchema = z.array(sessionMessageSchema).max(TRANSCRIPT_MESSAGE_MAX_ITEMS);

const lineRangeSchema = z
	.strictObject({ start: countSchema.positive(), end: countSchema.positive() })
	.refine((range) => range.end >= range.start);
export const fileReferenceSchema = createMessageFileReferenceSchema(
	z.discriminatedUnion("scope", [
		z.strictObject({ scope: z.literal("project"), path: fieldSchema, lineRange: lineRangeSchema.optional() }),
		z.strictObject({ scope: z.literal("external"), path: absolutePathSchema }),
	]),
);
const queuedMessageSchema = z.strictObject({
	readOnly: z.boolean().optional(),
	text: textSchema,
	draftText: textSchema,
	images: z.array(imageSchema).max(SESSION_IMAGE_MAX_ITEMS),
	fileReferences: z.array(fileReferenceSchema).max(256),
});
const queueSchema = z.strictObject({
	revision: countSchema,
	steering: z.array(queuedMessageSchema).max(COLLECTION_MAX_ITEMS),
	followUp: z.array(queuedMessageSchema).max(COLLECTION_MAX_ITEMS),
});

export const diagnosticSchema = z.strictObject({
	protocolVersion: z.literal(1),
	code: z.enum([
		"PI_SERVICE_DIAGNOSTIC",
		"PI_EXTENSION_LOAD_FAILED",
		"PI_SKILL_DIAGNOSTIC",
		"PI_PROMPT_DIAGNOSTIC",
		"PI_THEME_DIAGNOSTIC",
		"PI_SESSION_SCHEMA_NEWER",
		"PI_DIAGNOSTIC_UNKNOWN",
	]),
	severity: z.enum(["info", "warning", "error"]),
	source: z.enum(["pi.services", "pi.extension", "pi.skill", "pi.prompt", "pi.theme", "pi.session", "pi.unknown"]),
	message: fieldSchema,
	path: absolutePathSchema.optional(),
	details: z.record(z.string().max(ID_MAX_CHARS), z.union([z.null(), z.boolean(), z.number(), fieldSchema])),
});

const stateSnapshotSchema = z.strictObject({
	busy: z.boolean(),
	queue: queueSchema,
	diagnostics: z.array(diagnosticSchema).max(COLLECTION_MAX_ITEMS),
});

export const snapshotSchema = z.strictObject({
	messages: sessionMessagesSchema,
	...stateSnapshotSchema.shape,
});

const commandCatalogSchema = z.strictObject({
	skills: z.array(z.strictObject({ name: fieldSchema, description: textSchema })).max(COLLECTION_MAX_ITEMS),
	prompts: z
		.array(z.strictObject({ name: fieldSchema, description: textSchema, argumentHint: fieldSchema.nullable() }))
		.max(COLLECTION_MAX_ITEMS),
	extensions: z
		.array(
			z.strictObject({ name: fieldSchema, description: textSchema.nullable(), hasArgumentCompletions: z.boolean() }),
		)
		.max(COLLECTION_MAX_ITEMS),
});

const resourceSnapshotSchema = z.strictObject({
	lifecycle: z.enum(["active", "replacing", "disposing", "disposed"]),
	replacementListeners: countSchema,
	snapshotChangedListeners: countSchema,
	transcriptInvalidatedListeners: countSchema,
	transcriptProjectionChangedListeners: countSchema,
	lifecycleFailureListeners: countSchema,
	replacementCoordinatorOwned: z.boolean(),
	queueMirrorOwned: z.boolean(),
	extensionUiOwned: z.boolean(),
	runtimeServicesOwned: z.boolean(),
});

export const runtimeStateSchema = z.strictObject({
	revision: countSchema.positive(),
	ref: sessionRefSchema,
	sessionFile: absolutePathSchema.nullable(),
	sessionName: textSchema.nullable(),
	snapshot: stateSnapshotSchema,
	commandCatalog: commandCatalogSchema,
	resources: resourceSnapshotSchema,
	summary: z.strictObject({
		sessionFilePath: absolutePathSchema,
		parentSessionFilePath: absolutePathSchema.optional(),
		manualFork: z.boolean().optional(),
		storedTitle: textSchema,
		updatedAt: timestampSchema,
		messageCount: countSchema,
		preview: textSchema,
		transcriptCacheKey: idSchema.nullable(),
	}),
});

export const reviewFileSchema = z.strictObject({
	path: fieldSchema,
	from: fieldSchema.optional(),
	status: z.enum(["modified", "added", "deleted", "renamed", "copied", "untracked", "conflicted", "clean"]),
	additions: countSchema.optional(),
	deletions: countSchema.optional(),
	diff: textSchema.optional(),
	identity: fieldSchema.optional(),
});

const sessionRelationSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("manualFork"),
		parentRef: sessionRefSchema,
		parentSessionFilePath: absolutePathSchema,
	}),
	z.strictObject({
		kind: z.literal("child"),
		parentRef: sessionRefSchema,
		parentSessionFilePath: absolutePathSchema,
		source: z.enum(["subagent", "workflow", "plugin", "unknown"]),
		confidence: z.enum(["strong", "medium", "weak"]),
		reason: textSchema,
	}),
]);
const sessionSummarySchema = z.strictObject({
	id: idSchema,
	cwd: absolutePathSchema,
	title: textSchema,
	createdAt: timestampSchema,
	updatedAt: timestampSchema,
	messageCount: countSchema,
	preview: textSchema,
	archivedAt: timestampSchema.optional(),
	pinnedAt: timestampSchema.optional(),
	relation: sessionRelationSchema.optional(),
});

const runOutcomeSchema = z.discriminatedUnion("status", [
	z.strictObject({ status: z.literal("success") }),
	z.strictObject({ status: z.literal("cancelled") }),
	z.strictObject({
		status: z.literal("failed"),
		message: textSchema,
		code: fieldSchema.optional(),
		restoredMessages: z.array(queuedMessageSchema).max(COLLECTION_MAX_ITEMS).optional(),
	}),
]);
const retryStatusSchema = z.union([
	z.strictObject({
		phase: z.literal("waiting"),
		attempt: countSchema,
		maxAttempts: countSchema,
		delayMs: countSchema,
		errorMessage: textSchema,
	}),
	z.strictObject({ phase: z.literal("running"), source: z.literal("branchSummary") }),
	z.strictObject({
		phase: z.literal("running"),
		source: z.literal("compaction"),
		reason: z.enum(["manual", "threshold", "overflow"]),
	}),
]);

export const runtimeEventSchema = z.discriminatedUnion("type", [
	z.strictObject({
		type: z.literal("toolExecutionChanged"),
		toolCallId: idSchema,
		progress: z
			.strictObject({
				toolCallId: idSchema,
				toolName: idSchema,
				text: z.string().max(TOOL_PROGRESS_MAX_CHARS),
				truncated: z.boolean(),
				rendered: renderedTextSchema.optional(),
			})
			.nullable(),
	}),
	z.strictObject({ type: z.literal("messageStart"), message: sessionMessageSchema }),
	z.strictObject({
		type: z.literal("messageUpdate"),
		message: sessionMessageSchema,
		streamMode: z.literal("full").optional(),
	}),
	z.strictObject({
		type: z.literal("messageDelta"),
		messageId: idSchema,
		occurredAt: timestampSchema,
		changes: z
			.array(
				z.strictObject({
					part: countSchema,
					kind: z.enum(["text", "thinking"]),
					offset: countSchema,
					append: textSchema,
				}),
			)
			.max(COLLECTION_MAX_ITEMS),
	}),
	z.strictObject({ type: z.literal("messageEnd"), message: sessionMessageSchema }),
	z.strictObject({ type: z.literal("turnEnd"), message: sessionMessageSchema }),
	z.strictObject({ type: z.literal("messagePersisted"), messageId: idSchema, entryId: idSchema }),
	z.strictObject({ type: z.literal("compactionSummary"), message: sessionMessageSchema }),
	z.strictObject({
		type: z.literal("transcriptInvalidated"),
		reason: z.enum(["compaction", "treeNavigation", "reload"]),
	}),
	z.strictObject({ type: z.literal("queueChanged"), queue: queueSchema }),
	z.strictObject({ type: z.literal("runStarted"), runId: idSchema, timestamp: timestampSchema }),
	z.strictObject({
		type: z.literal("runFinished"),
		runId: idSchema,
		outcome: runOutcomeSchema,
		timestamp: timestampSchema,
	}),
	z.strictObject({ type: z.literal("summarizationRetryChanged"), status: retryStatusSchema.nullable() }),
	z.strictObject({
		type: z.literal("autoRetryChanged"),
		status: z
			.strictObject({ attempt: countSchema, maxAttempts: countSchema, delayMs: countSchema, errorMessage: textSchema })
			.nullable(),
	}),
	z.strictObject({ type: z.literal("commandsChanged"), revision: countSchema }),
	z.strictObject({ type: z.literal("extensionUiChanged"), revision: countSchema }),
	z.strictObject({ type: z.literal("sessionSummaryChanged"), summary: sessionSummarySchema }),
	z.strictObject({ type: z.literal("sessionCatalogChanged"), reason: z.enum(["replacement", "external"]) }),
	z.strictObject({
		type: z.literal("sessionReplaced"),
		previousRef: sessionRefSchema,
		reason: z.enum(["new", "fork", "switch", "refresh"]),
	}),
	z.strictObject({ type: z.literal("snapshotChanged") }),
	z.strictObject({ type: z.literal("transcriptProjectionChanged"), reason: z.literal("markdownWidth") }),
	z.strictObject({
		type: z.literal("activity"),
		id: idSchema,
		text: textSchema,
		tone: z.enum(["normal", "error"]).optional(),
	}),
	z.strictObject({ type: z.literal("changeReviewFileUpdated"), path: fieldSchema, file: reviewFileSchema.nullable() }),
	z.strictObject({
		type: z.literal("changeReviewTrackingFailed"),
		code: z.enum(["CAPTURE_FAILED", "DIFF_LIMIT_EXCEEDED", "TURN_LIMIT_EXCEEDED"]),
	}),
]);
