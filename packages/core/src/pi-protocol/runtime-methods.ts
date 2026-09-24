import type { ExtensionAutocompleteSuggestions, ModelState, ToolResultSessionMessage } from "@ling/contracts/session";
import { piResourceReloadModeSchema } from "@ling/contracts/session";
import { EXTENSION_UI_INPUT_MAX_CHARS, SESSION_IMAGE_MAX_ITEMS } from "@ling/contracts/session";
import { z } from "zod";
import { mcpCommandSchema } from "@ling/contracts/mcp";
import { companionRunRequestSchema, companionRunSchema, toolResultSnapshotSchema } from "@ling/contracts/companions";
import { piMethod, piVoidMethod, runtimeMethod } from "./method";
import type { PiWorkerRuntimeSnapshotResult, PiWorkerRuntimeStateSnapshotResult } from "./protocol";
import { command, LIFECYCLE_REQUEST_TIMEOUT_MS, LONG_REQUEST_TIMEOUT_MS, runtimeQuery } from "./request-policy";
import * as outputs from "./runtime-operation-results";
import {
	COLLECTION_MAX_ITEMS,
	countSchema,
	fileReferenceSchema,
	idSchema as identifierSchema,
	idSchema,
	imageSchema,
	textSchema as outputTextSchema,
	runtimeStateSchema,
	sessionMessageSchema,
	sessionRefSchema,
	snapshotSchema,
	fieldSchema as textSchema,
} from "./runtime-payload-schemas";
const extensionUiInputSchema = z.string().max(EXTENSION_UI_INPUT_MAX_CHARS);
// Terminal geometry is bounded independently of viewport pixel dimensions.
const dimension = z.number().int().positive().max(10_000);
// The attachment count and file-reference fan-out bound the serialized prompt.
const imagesSchema = z.array(imageSchema).max(SESSION_IMAGE_MAX_ITEMS);
const fileReferencesSchema = z.array(fileReferenceSchema).max(256);
export const piRuntimeMethods = {
	"runtime.deliverReply": runtimeMethod(
		piVoidMethod(
			z.strictObject({ requestId: identifierSchema, text: textSchema }),
			command({ timeoutMs: LONG_REQUEST_TIMEOUT_MS }),
		),
		["requestId", "text"],
		{ busy: true },
	),
	"runtime.readLatestToolResult": runtimeMethod(
		piMethod(
			z.strictObject({ toolName: identifierSchema }),
			(value: unknown) => toolResultSnapshotSchema.nullable().parse(value),
			runtimeQuery(),
		),
		["toolName"],
		{},
	),
	"runtime.readCustomEntry": runtimeMethod(
		piMethod(
			z.strictObject({ customType: identifierSchema }),
			(value: unknown) => z.json().parse(value),
			runtimeQuery(),
		),
		["customType"],
		{},
	),
	"runtime.startCompanionRun": runtimeMethod(
		piMethod(
			z.strictObject({
				runId: identifierSchema,
				text: textSchema,
				configuration: companionRunRequestSchema.pick({ model: true, thinking: true }),
			}),
			(value: unknown) => companionRunSchema.nullable().parse(value),
			command({ timeoutMs: LONG_REQUEST_TIMEOUT_MS }),
		),
		["runId", "text", "configuration"],
		// Keep the worker owned while admission crosses IPC and configures the model.
		{ busy: true },
	),
	"runtime.waitCompanionRun": runtimeMethod(
		piMethod(
			z.strictObject({ runId: identifierSchema }),
			(value: unknown) => companionRunSchema.parse(value),
			runtimeQuery({ timeoutMs: LONG_REQUEST_TIMEOUT_MS }),
		),
		["runId"],
		{},
	),
	"runtime.cancelCompanionRun": runtimeMethod(
		piMethod(
			z.strictObject({ runId: identifierSchema }),
			(value: unknown) => companionRunSchema.parse(value),
			command(),
		),
		["runId"],
		{},
	),
	"runtime.getSnapshot": runtimeMethod(
		piMethod(
			z.strictObject({}),
			(value: unknown) => {
				return z
					.strictObject({ ref: sessionRefSchema, snapshot: snapshotSchema, eventSequence: countSchema })
					.parse(value) as PiWorkerRuntimeSnapshotResult;
			},
			runtimeQuery({ timeoutMs: LIFECYCLE_REQUEST_TIMEOUT_MS, deferHeartbeat: true }),
		),
		[],
		{},
	),
	"runtime.getStateSnapshot": runtimeMethod(
		piMethod(
			z.strictObject({}),
			(value: unknown) => {
				return z
					.strictObject({
						ref: sessionRefSchema,
						snapshot: runtimeStateSchema.shape.snapshot,
						eventSequence: countSchema,
					})
					.parse(value) as PiWorkerRuntimeStateSnapshotResult;
			},
			runtimeQuery({ timeoutMs: LIFECYCLE_REQUEST_TIMEOUT_MS, deferHeartbeat: true }),
		),
		[],
		{},
	),
	/** The active branch leaf anchors a fork of the whole branch. */
	"runtime.getBranchLeafEntryId": runtimeMethod(
		piMethod(
			z.strictObject({}),
			(value: unknown) => {
				return idSchema.nullable().parse(value);
			},
			runtimeQuery({
				timeoutMs: LIFECYCLE_REQUEST_TIMEOUT_MS,
				deferHeartbeat: true,
			}),
		),
		[],
		{},
	),
	/** Opening prompt used for an automatically generated session title. */
	"runtime.getFirstUserMessageText": runtimeMethod(
		piMethod(
			z.strictObject({}),
			(value: unknown) => {
				return outputTextSchema.nullable().parse(value);
			},
			runtimeQuery({
				timeoutMs: LIFECYCLE_REQUEST_TIMEOUT_MS,
				deferHeartbeat: true,
			}),
		),
		[],
		{},
	),
	"runtime.setSessionName": runtimeMethod(piVoidMethod(z.strictObject({ title: textSchema }), command()), ["title"], {
		busy: true,
		acceptReplacement: true,
	}),
	"runtime.generateTitle": runtimeMethod(
		piMethod(
			z.strictObject({ userMessage: textSchema }),
			(value: unknown) => {
				return outputTextSchema.nullable().parse(value);
			},
			runtimeQuery({ timeoutMs: LONG_REQUEST_TIMEOUT_MS }),
		),
		["userMessage"],
		{ busy: true },
	),
	/** Reopens the current file through same-target replacement so projections and listeners rebind. */
	"runtime.refreshFromDisk": runtimeMethod(
		piVoidMethod(z.strictObject({}), command({ timeoutMs: LIFECYCLE_REQUEST_TIMEOUT_MS, deferHeartbeat: true })),
		[],
		{ busy: true },
	),
	/** Rebuilds extension, tool and skill resources while idle, preserving the session identity. */
	"runtime.reloadResources": runtimeMethod(
		piVoidMethod(
			z.strictObject({ mode: piResourceReloadModeSchema.optional() }),
			command({ timeoutMs: LIFECYCLE_REQUEST_TIMEOUT_MS, deferHeartbeat: true }),
		),
		["mode"],
		{ busy: true },
	),
	"runtime.readToolResult": runtimeMethod(
		piMethod(
			z.strictObject({ entryId: identifierSchema }),
			(value: unknown): ToolResultSessionMessage => {
				const message = sessionMessageSchema.parse(value);
				if (message.role !== "toolResult" || message.contentState === "deferred")
					throw new Error("Invalid tool result detail response");
				return message as ToolResultSessionMessage;
			},
			runtimeQuery({ timeoutMs: LIFECYCLE_REQUEST_TIMEOUT_MS }),
		),
		["entryId"],
		{},
	),
	/** Bytes of one persisted image; null means its entry or part no longer exists. */
	"runtime.readImagePart": runtimeMethod(
		piMethod(
			z.strictObject({ entryId: identifierSchema, index: z.number().int().nonnegative() }),
			(value: unknown) => {
				return imageSchema.nullable().parse(value);
			},
			runtimeQuery({ timeoutMs: LIFECYCLE_REQUEST_TIMEOUT_MS }),
		),
		["entryId", "index"],
		{},
	),
	"runtime.sendPrompt": runtimeMethod(
		piVoidMethod(
			z.strictObject({ text: textSchema, images: imagesSchema.optional() }),
			command({ timeoutMs: LONG_REQUEST_TIMEOUT_MS }),
		),
		["text", "images"],
		{ busy: true, acceptReplacement: true },
	),
	"runtime.runMcpCommand": runtimeMethod(
		piVoidMethod(z.strictObject({ input: mcpCommandSchema }), command({ timeoutMs: LONG_REQUEST_TIMEOUT_MS })),
		["input"],
		{ busy: true },
	),
	"runtime.steer": runtimeMethod(
		piVoidMethod(
			z.strictObject({
				text: textSchema,
				images: imagesSchema.optional(),
				fileReferences: fileReferencesSchema.optional(),
			}),
			command(),
		),
		["text", "images", "fileReferences"],
		{ busy: true },
	),
	"runtime.followUp": runtimeMethod(
		piVoidMethod(
			z.strictObject({
				text: textSchema,
				images: imagesSchema.optional(),
				fileReferences: fileReferencesSchema.optional(),
			}),
			command(),
		),
		["text", "images", "fileReferences"],
		{ busy: true },
	),
	"runtime.editQueuedMessage": runtimeMethod(
		piVoidMethod(
			z.strictObject({
				kind: z.enum(["steering", "followUp"]),
				index: z.number().int().nonnegative(),
				expectedText: textSchema,
				text: textSchema.nullable(),
				images: imagesSchema.optional(),
				fileReferences: fileReferencesSchema.optional(),
			}),
			command(),
		),
		["kind", "index", "expectedText", "text", "images", "fileReferences"],
		{ busy: true },
	),
	"runtime.promoteQueuedMessage": runtimeMethod(
		piVoidMethod(z.strictObject({ index: z.number().int().nonnegative(), expectedText: textSchema }), command()),
		["index", "expectedText"],
		{ busy: true },
	),
	/** Returns queued texts cleared by abort so the Host can restore user input. */
	"runtime.abort": runtimeMethod(
		piMethod(
			z.strictObject({}),
			(value: unknown) => {
				return z.strictObject({ restoredTexts: z.array(outputTextSchema).max(COLLECTION_MAX_ITEMS) }).parse(value);
			},
			command(),
		),
		[],
		{ busy: true },
	),
	"runtime.compact": runtimeMethod(
		piVoidMethod(
			z.strictObject({ customInstructions: textSchema.optional() }),
			command({ timeoutMs: LONG_REQUEST_TIMEOUT_MS }),
		),
		["customInstructions"],
		{ busy: true },
	),
	/** Moves the branch leaf before the entry so the next send opens a sibling branch. */
	"runtime.retryTurn": runtimeMethod(
		piVoidMethod(
			z.strictObject({ entryId: identifierSchema }),
			command({ timeoutMs: LONG_REQUEST_TIMEOUT_MS, deferHeartbeat: true }),
		),
		["entryId"],
		{ busy: true, acceptReplacement: true },
	),
	"runtime.rewindToEntry": runtimeMethod(
		piVoidMethod(z.strictObject({ entryId: identifierSchema }), command()),
		["entryId"],
		{},
	),
	"runtime.getCommandArgumentCompletions": runtimeMethod(
		piMethod(
			z.strictObject({ commandName: identifierSchema, argumentPrefix: textSchema }),
			(value: unknown) => {
				return outputs.autocompleteSuggestionsSchema.nullable().parse(value) as ExtensionAutocompleteSuggestions | null;
			},
			runtimeQuery(),
		),
		["commandName", "argumentPrefix"],
		{ busy: true, signal: true },
	),
	"runtime.sendExtensionUiInput": runtimeMethod(
		piMethod(
			z.strictObject({ data: extensionUiInputSchema }),
			(value: unknown) => {
				return z.strictObject({ consumed: z.boolean(), data: extensionUiInputSchema }).parse(value);
			},
			command(),
		),
		["data"],
		{ acceptReplacement: true },
	),
	/** Terminal input must return within one second to avoid wedging the interactive editor. */
	"runtime.dispatchExtensionTerminalInput": runtimeMethod(
		piMethod(
			z.strictObject({ data: extensionUiInputSchema }),
			(value: unknown) => {
				return z.strictObject({ consumed: z.boolean(), data: extensionUiInputSchema }).parse(value);
			},
			command(),
		),
		["data"],
		{ acceptReplacement: true, timeoutMs: 1000 },
	),
	"runtime.updateExtensionUiViewport": runtimeMethod(
		piVoidMethod(
			z.strictObject({
				columns: dimension,
				rows: dimension,
				markdownColumns: dimension,
				dockColumns: dimension,
			}),
			command(),
		),
		["columns", "rows", "markdownColumns", "dockColumns"],
		{},
	),
	"runtime.setExtensionUiEditorText": runtimeMethod(
		piVoidMethod(z.strictObject({ text: textSchema }), command()),
		["text"],
		{},
	),
	"runtime.getExtensionAutocompleteSuggestions": runtimeMethod(
		piMethod(
			z.strictObject({
				text: textSchema,
				cursorOffset: z.number().int().nonnegative(),
				force: z.boolean(),
			}),
			(value: unknown) => {
				return outputs.autocompleteSuggestionsSchema.nullable().parse(value) as ExtensionAutocompleteSuggestions | null;
			},
			runtimeQuery(),
		),
		["text", "cursorOffset", "force"],
		{ busy: true, signal: true },
	),
	"runtime.applyExtensionAutocomplete": runtimeMethod(
		piMethod(
			z.strictObject({
				text: textSchema,
				cursorOffset: z.number().int().nonnegative(),
				item: z
					.strictObject({
						value: textSchema,
						label: textSchema,
						description: textSchema.optional(),
					})
					.transform(({ description, ...item }) => (description === undefined ? item : { ...item, description })),
				prefix: textSchema,
			}),
			(value: unknown) => {
				return z.strictObject({ text: outputTextSchema, cursorOffset: countSchema }).parse(value);
			},
			runtimeQuery(),
		),
		["text", "cursorOffset", "item", "prefix"],
		{},
	),
	"runtime.getModelState": runtimeMethod(
		piMethod(
			z.strictObject({}),
			(value: unknown) => {
				return outputs.modelStateSchema.parse(value) as ModelState;
			},
			runtimeQuery(),
		),
		[],
		{},
	),
	"runtime.setModel": runtimeMethod(
		piMethod(
			z.strictObject({ provider: identifierSchema, modelId: identifierSchema }),
			(value: unknown) => {
				return outputs.modelStateSchema.parse(value) as ModelState;
			},
			command(),
		),
		["provider", "modelId"],
		{ busy: true },
	),
	"runtime.setThinkingLevel": runtimeMethod(
		piMethod(
			z.strictObject({ level: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]) }),
			(value: unknown) => {
				return outputs.modelStateSchema.parse(value) as ModelState;
			},
			command(),
		),
		["level"],
		{ busy: true },
	),
	"runtime.dispose": runtimeMethod(
		piVoidMethod(
			z.strictObject({ rollbackSessionFile: z.boolean().optional() }),
			command({ timeoutMs: LIFECYCLE_REQUEST_TIMEOUT_MS }),
		),
		["rollbackSessionFile"],
		{},
	),
};
export type PiRuntimeMethod = keyof typeof piRuntimeMethods;
