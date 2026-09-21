import { SESSION_ID_MAX_CHARS } from "./path-bounds";
import { PROJECT_FILE_REFERENCE_MAX_ITEMS, type ProjectFileReferenceTarget } from "./project";
import {
	EXTENSION_AUTOCOMPLETE_DESCRIPTION_MAX_CHARS,
	EXTENSION_AUTOCOMPLETE_LABEL_MAX_CHARS,
	EXTENSION_UI_INPUT_MAX_CHARS,
	EXTENSION_UI_TEXT_MAX_CHARS,
	SESSION_IMAGE_MAX_BYTES,
	SESSION_IMAGE_MAX_ITEMS,
	sessionImageMimeTypeSchema,
	SESSION_IMAGE_TOTAL_MAX_BYTES,
	SESSION_MESSAGE_TEXT_MAX_CHARS,
	SESSION_TITLE_MAX_CHARS,
	THINKING_LEVELS,
	type ExtensionAutocompleteItem,
} from "./session";
import { operationRefSchema } from "./owner-ref";
import { boundedString, nonEmptyBoundedString, safeIdSchema } from "./schema-primitives";
import { MODEL_ID_MAX_CHARS, MODEL_PROVIDER_ID_MAX_CHARS } from "./model";
import { sessionRefSchema as portableSessionRefSchema, type SessionRef } from "./session-ref";
import { portableAbsolutePathSchema } from "./path-validation";
import { createProjectFileSchemas } from "./project-file-requests";
import { dialogRequestIdSchema } from "./session-shell-validation";
import { z } from "zod";

/** Reuse native/portable path validation while adding message-only placement metadata. */
export function createMessageFileReferenceSchema(reference: z.ZodType<ProjectFileReferenceTarget>) {
	return z
		.preprocess(
			(raw) => {
				if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
				const { textOffset, ...target } = raw as Record<string, unknown>;
				return { reference: target, textOffset };
			},
			z.strictObject({ reference, textOffset: z.number().int().min(0).max(SESSION_MESSAGE_TEXT_MAX_CHARS).optional() }),
		)
		.transform(({ reference: target, textOffset }) => (textOffset === undefined ? target : { ...target, textOffset }));
}

/** Native hosts supply their path rules here; all request fields keep one definition. */
export function createSessionRequestSchemas({
	projectPath = portableAbsolutePathSchema("Project path"),
	sessionRef = portableSessionRefSchema,
	fileReference = createProjectFileSchemas().projectFileReferenceTargetSchema,
}: {
	projectPath?: z.ZodType<string>;
	sessionRef?: z.ZodType<SessionRef>;
	fileReference?: z.ZodType<ProjectFileReferenceTarget>;
} = {}) {
	/** Timeline entry/message entryId cap: same short-id magnitude as sessionId. */
	const MAX_ENTRY_ID_LENGTH = SESSION_ID_MAX_CHARS;
	/** Slash-command name cap; 512 covers namespaced commands — longer is junk input. */
	const MAX_COMMAND_NAME_LENGTH = 512;
	/** Extension UI viewport width/height pixel cap; 10k stops absurd geometry from bloating layout/serialization. */
	const MAX_VIEWPORT_DIMENSION = 10_000;
	/** Session runtimeId cap; generation switches use short ids — longer is refused. */
	const MAX_RUNTIME_ID_LENGTH = 256;
	/** Transcript pagination cursor string cap; 2Ki encodes an offset — no unbounded cursor in memory. */
	const MAX_TRANSCRIPT_CURSOR_LENGTH = 2_048;
	/** Resource revision plus a 43-character SHA-256 key stays small; 128 leaves version headroom without accepting blobs. */
	const MAX_TRANSCRIPT_CACHE_KEY_LENGTH = 128;
	/** Max transcript entries per page. 200 balances scrolling and IPC size; larger makes a single payload too heavy. */
	const MAX_TRANSCRIPT_PAGE_LIMIT = 200;
	const maxEncodedImageLength = Math.ceil(SESSION_IMAGE_MAX_BYTES / 3) * 4;

	const cwdSchema = projectPath;
	const sessionRefSchema = sessionRef;
	const messageFileReferenceSchema = createMessageFileReferenceSchema(fileReference);
	const entryIdSchema = safeIdSchema(MAX_ENTRY_ID_LENGTH, "Entry id");
	const providerIdSchema = safeIdSchema(MODEL_PROVIDER_ID_MAX_CHARS, "Provider id");
	const modelIdSchema = safeIdSchema(MODEL_ID_MAX_CHARS, "Model id");
	const titleSchema = nonEmptyBoundedString(SESSION_TITLE_MAX_CHARS, "Session title");
	const messageTextSchema = boundedString(SESSION_MESSAGE_TEXT_MAX_CHARS, "Message text");
	const nonNegativeIndexSchema = z.number().int().nonnegative();

	const sessionRuntimeBindingShape = {
		runtimeId: safeIdSchema(MAX_RUNTIME_ID_LENGTH, "Runtime id"),
		generation: nonNegativeIndexSchema,
	};

	const sessionRuntimeTargetShape = {
		ref: sessionRefSchema,
		...sessionRuntimeBindingShape,
	};

	const readToolResultRequestSchema = z.strictObject({
		...sessionRuntimeTargetShape,
		entryId: safeIdSchema(MAX_RUNTIME_ID_LENGTH, "Entry id"),
		expectedTranscriptRevision: nonNegativeIndexSchema,
	});

	const sessionRuntimeBindingRequestSchema = z.strictObject(sessionRuntimeTargetShape);

	function decodedBase64ByteLength(value: string): number {
		const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
		return (value.length / 4) * 3 - padding;
	}

	// Hand-written base64 char mapping (A-Z a-z 0-9 + /), avoiding regex backtracking risk on huge inputs
	function base64Value(charCode: number): number {
		if (charCode >= 65 && charCode <= 90) return charCode - 65;
		if (charCode >= 97 && charCode <= 122) return charCode - 71;
		if (charCode >= 48 && charCode <= 57) return charCode + 4;
		if (charCode === 43) return 62;
		if (charCode === 47) return 63;
		return -1;
	}

	/** Linear validation avoids the large-input backtracking/stack risk of a base64 regex. */
	function isCanonicalBase64(value: string): boolean {
		if (value.length === 0 || value.length > maxEncodedImageLength || value.length % 4 !== 0) return false;
		const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
		const contentLength = value.length - padding;
		for (let index = 0; index < contentLength; index += 1) {
			if (base64Value(value.charCodeAt(index)) < 0) return false;
		}
		for (let index = contentLength; index < value.length; index += 1) {
			if (value.charCodeAt(index) !== 61) return false;
		}
		if (padding === 2) return (base64Value(value.charCodeAt(contentLength - 1)) & 0x0f) === 0;
		if (padding === 1) return (base64Value(value.charCodeAt(contentLength - 1)) & 0x03) === 0;
		return true;
	}

	const imageDataSchema = z
		.string()
		.min(4, "Image data must not be empty")
		.max(maxEncodedImageLength, "Image data is too large")
		.refine(isCanonicalBase64, "Image data must be canonical base64");

	const imageAttachmentSchema = z
		.strictObject({
			type: z.literal("image"),
			data: imageDataSchema,
			mimeType: sessionImageMimeTypeSchema,
		})
		.superRefine((image, context) => {
			if (decodedBase64ByteLength(image.data) > SESSION_IMAGE_MAX_BYTES) {
				context.addIssue({ code: "custom", path: ["data"], message: "Decoded image is too large" });
			}
		});

	const imageAttachmentsSchema = z
		.array(imageAttachmentSchema)
		.max(SESSION_IMAGE_MAX_ITEMS, `At most ${SESSION_IMAGE_MAX_ITEMS} images may be sent`)
		.superRefine((images, context) => {
			const totalBytes = images.reduce((total, image) => total + decodedBase64ByteLength(image.data), 0);
			if (totalBytes > SESSION_IMAGE_TOTAL_MAX_BYTES) {
				context.addIssue({ code: "custom", message: "Combined decoded image data is too large" });
			}
		});

	const createSessionRequestSchema = z.strictObject({
		cwd: cwdSchema,
		title: titleSchema.optional(),
		model: z.strictObject({ provider: providerIdSchema, modelId: modelIdSchema }).optional(),
		thinkingLevel: z.enum(THINKING_LEVELS).optional(),
	});

	const resumeSessionRequestSchema = z.strictObject({ ref: sessionRefSchema });

	const sessionSnapshotRequestSchema = z.strictObject({
		ref: sessionRefSchema,
		/** Sent only when the renderer already owns a fully hydrated transcript. */
		transcriptCache: z
			.strictObject({
				cacheKey: safeIdSchema(MAX_TRANSCRIPT_CACHE_KEY_LENGTH, "Transcript cache key"),
				runtimeId: safeIdSchema(MAX_RUNTIME_ID_LENGTH, "Runtime id").nullable(),
				generation: nonNegativeIndexSchema,
				transcriptRevision: nonNegativeIndexSchema,
			})
			.optional(),
	});

	const sendMessageRequestSchema = z.strictObject({
		ref: sessionRefSchema,
		text: messageTextSchema,
		mode: z.enum(["prompt", "steer", "followUp"]),
		images: imageAttachmentsSchema.optional(),
		fileReferences: messageFileReferenceSchema.array().max(PROJECT_FILE_REFERENCE_MAX_ITEMS).optional(),
	});

	const listComposerHistoryRequestSchema = z.strictObject({
		cwd: cwdSchema,
	});

	const emptySessionRequestSchema = z.undefined();

	const sessionCommandArgumentCompletionRequestSchema = z.strictObject({
		operation: operationRefSchema,
		ref: sessionRefSchema,
		runtimeId: safeIdSchema(MAX_RUNTIME_ID_LENGTH, "Runtime id"),
		generation: nonNegativeIndexSchema,
		deadlineAt: z.number().int().positive(),
		commandName: safeIdSchema(MAX_COMMAND_NAME_LENGTH, "Command name"),
		argumentPrefix: boundedString(EXTENSION_UI_INPUT_MAX_CHARS, "Command argument prefix"),
	});

	const editQueuedRequestSchema = z.strictObject({
		ref: sessionRefSchema,
		kind: z.enum(["steering", "followUp"]),
		index: nonNegativeIndexSchema,
		/** Revision of the queue that supplied index and expectedText. */
		expectedRevision: nonNegativeIndexSchema,
		/** Reject the edit when the queue moved underneath the rendered index. */
		expectedText: messageTextSchema,
		/** Null removes the queued message. */
		text: messageTextSchema.nullable(),
		/** Omission retains images; an explicit array replaces them, including an empty array. */
		images: imageAttachmentsSchema.optional(),
		/** Same replacement semantics as images. */
		fileReferences: messageFileReferenceSchema.array().max(PROJECT_FILE_REFERENCE_MAX_ITEMS).optional(),
	});

	const promoteQueuedRequestSchema = z.strictObject({
		ref: sessionRefSchema,
		index: nonNegativeIndexSchema,
		expectedRevision: nonNegativeIndexSchema,
		expectedText: messageTextSchema,
	});

	/** Only the session identity crosses the wire; Host resolves its file from the catalog it owns,
	 * so a client cannot name an arbitrary file to read. */
	const readArchivedTranscriptRequestSchema = z.strictObject({
		ref: sessionRefSchema,
		markdownWidth: z.number().int().min(0).max(10_000),
	});

	const readTranscriptPageRequestSchema = z.strictObject({
		operation: operationRefSchema,
		ref: sessionRefSchema,
		runtimeId: safeIdSchema(MAX_RUNTIME_ID_LENGTH, "Runtime id"),
		generation: nonNegativeIndexSchema,
		cursor: nonEmptyBoundedString(MAX_TRANSCRIPT_CURSOR_LENGTH, "Transcript cursor"),
		direction: z.enum(["older", "newer"]),
		limit: z.number().int().min(1).max(MAX_TRANSCRIPT_PAGE_LIMIT),
		expectedTranscriptRevision: nonNegativeIndexSchema,
		deadlineAt: z.number().int().positive(),
	});

	const readSessionCompanionRequestSchema = z.strictObject({
		ref: sessionRefSchema,
		runtimeId: safeIdSchema(MAX_RUNTIME_ID_LENGTH, "Runtime id"),
		generation: nonNegativeIndexSchema,
		expectedRevision: nonNegativeIndexSchema.optional(),
	});

	const cancelSessionOperationRequestSchema = z.strictObject({
		operation: operationRefSchema,
		ref: sessionRefSchema,
		runtimeId: safeIdSchema(MAX_RUNTIME_ID_LENGTH, "Runtime id"),
		generation: nonNegativeIndexSchema,
	});

	const setSessionModelRequestSchema = z.strictObject({
		...sessionRuntimeTargetShape,
		provider: providerIdSchema,
		modelId: modelIdSchema,
	});

	const setSessionThinkingLevelRequestSchema = z.strictObject({
		...sessionRuntimeTargetShape,
		level: z.enum(THINKING_LEVELS),
	});

	const setSessionArchivedRequestSchema = z.strictObject({
		ref: sessionRefSchema,
		archived: z.boolean(),
	});

	const setSessionPinnedRequestSchema = z.strictObject({
		ref: sessionRefSchema,
		pinned: z.boolean(),
	});

	const forkSessionRequestSchema = z.strictObject({
		ref: sessionRefSchema,
		entryId: entryIdSchema,
	});

	const rewindSessionRequestSchema = z.strictObject({
		ref: sessionRefSchema,
		entryId: entryIdSchema,
	});

	const renameSessionRequestSchema = z.strictObject({
		ref: sessionRefSchema,
		title: titleSchema,
	});

	const compactSessionRequestSchema = z.strictObject({
		ref: sessionRefSchema,
		customInstructions: messageTextSchema.optional(),
	});

	const approvalResponseSchema = z.strictObject({
		requestId: dialogRequestIdSchema,
		approved: z.boolean(),
	});

	const extensionUiResponseSchema = z.strictObject({
		requestId: dialogRequestIdSchema,
		value: boundedString(EXTENSION_UI_TEXT_MAX_CHARS, "Extension UI response").nullable(),
	});

	const extensionUiInputRequestSchema = z.strictObject({
		ref: sessionRefSchema,
		data: boundedString(EXTENSION_UI_INPUT_MAX_CHARS, "Extension UI input"),
	});

	const viewportDimensionSchema = z.number().int().min(1).max(MAX_VIEWPORT_DIMENSION);

	const extensionUiViewportRequestSchema = z.strictObject({
		ref: sessionRefSchema,
		columns: viewportDimensionSchema,
		rows: viewportDimensionSchema,
		markdownColumns: viewportDimensionSchema,
		dockColumns: viewportDimensionSchema,
	});

	const extensionUiEditorTextRequestSchema = z.strictObject({
		ref: sessionRefSchema,
		...sessionRuntimeBindingShape,
		text: boundedString(EXTENSION_UI_TEXT_MAX_CHARS, "Extension editor text"),
	});

	const extensionAutocompleteInputShape = {
		ref: sessionRefSchema,
		text: boundedString(EXTENSION_UI_TEXT_MAX_CHARS, "Autocomplete text"),
		cursorOffset: nonNegativeIndexSchema,
		force: z.boolean().optional(),
	};

	const extensionAutocompleteOperationShape = {
		operation: operationRefSchema,
		...sessionRuntimeBindingShape,
		deadlineAt: z.number().int().positive(),
	};

	function validateCursorOffset(request: { text: string; cursorOffset: number }, context: z.RefinementCtx): void {
		if (request.cursorOffset > request.text.length) {
			context.addIssue({ code: "custom", path: ["cursorOffset"], message: "Cursor offset is outside the text" });
		}
	}

	const extensionAutocompleteRequestSchema = z
		.strictObject({ ...extensionAutocompleteInputShape, ...extensionAutocompleteOperationShape })
		.superRefine(validateCursorOffset)
		.transform((request) => ({
			operation: request.operation,
			ref: request.ref,
			runtimeId: request.runtimeId,
			generation: request.generation,
			deadlineAt: request.deadlineAt,
			text: request.text,
			cursorOffset: request.cursorOffset,
			...(request.force === undefined ? {} : { force: request.force }),
		}));

	const extensionAutocompleteItemSchema = z.strictObject({
		value: boundedString(EXTENSION_UI_INPUT_MAX_CHARS, "Autocomplete value"),
		label: boundedString(EXTENSION_AUTOCOMPLETE_LABEL_MAX_CHARS, "Autocomplete label"),
		description: boundedString(EXTENSION_AUTOCOMPLETE_DESCRIPTION_MAX_CHARS, "Autocomplete description").optional(),
	});

	function normalizeAutocompleteItem(item: z.infer<typeof extensionAutocompleteItemSchema>): ExtensionAutocompleteItem {
		return {
			value: item.value,
			label: item.label,
			...(item.description === undefined ? {} : { description: item.description }),
		};
	}

	const applyExtensionAutocompleteRequestSchema = z
		.strictObject({
			...extensionAutocompleteInputShape,
			...sessionRuntimeBindingShape,
			item: extensionAutocompleteItemSchema,
			prefix: boundedString(EXTENSION_UI_INPUT_MAX_CHARS, "Autocomplete prefix"),
		})
		.superRefine(validateCursorOffset)
		.transform((request) => ({
			ref: request.ref,
			runtimeId: request.runtimeId,
			generation: request.generation,
			text: request.text,
			cursorOffset: request.cursorOffset,
			...(request.force === undefined ? {} : { force: request.force }),
			item: normalizeAutocompleteItem(request.item),
			prefix: request.prefix,
		}));

	return {
		readToolResultRequestSchema,
		sessionRuntimeBindingRequestSchema,
		createSessionRequestSchema,
		resumeSessionRequestSchema,
		sessionSnapshotRequestSchema,
		sendMessageRequestSchema,
		listComposerHistoryRequestSchema,
		emptySessionRequestSchema,
		sessionCommandArgumentCompletionRequestSchema,
		editQueuedRequestSchema,
		promoteQueuedRequestSchema,
		readTranscriptPageRequestSchema,
		readArchivedTranscriptRequestSchema,
		readSessionCompanionRequestSchema,
		cancelSessionOperationRequestSchema,
		setSessionModelRequestSchema,
		setSessionThinkingLevelRequestSchema,
		setSessionArchivedRequestSchema,
		setSessionPinnedRequestSchema,
		forkSessionRequestSchema,
		rewindSessionRequestSchema,
		renameSessionRequestSchema,
		compactSessionRequestSchema,
		approvalResponseSchema,
		extensionUiResponseSchema,
		extensionUiInputRequestSchema,
		extensionUiViewportRequestSchema,
		extensionUiEditorTextRequestSchema,
		extensionAutocompleteRequestSchema,
		applyExtensionAutocompleteRequestSchema,
	};
}
