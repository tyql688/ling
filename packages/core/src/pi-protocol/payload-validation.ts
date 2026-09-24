import {
	EXTENSION_UI_KEY_MAX_CHARS,
	EXTENSION_UI_RENDERED_LINE_MAX_ITEMS,
	EXTENSION_UI_TEXT_MAX_CHARS,
	EXTENSION_UI_WORKING_FRAME_MAX_ITEMS,
} from "@ling/contracts/session";
import { z } from "zod";
import { parsePiWorkerDomainEvent } from "./domain-payload-schemas";
import type { PiWorkerEvent } from "./protocol";
import {
	COLLECTION_MAX_ITEMS,
	countSchema,
	errorDetailsSchema,
	fieldSchema,
	idSchema,
	runtimeEventSchema,
	runtimeStateSchema,
	sessionRefSchema,
	textSchema,
} from "./runtime-payload-schemas";
import { PI_WORKER_PROTOCOL_VERSION } from "./wire-format";

const extensionUiTextSchema = z.string().max(EXTENSION_UI_TEXT_MAX_CHARS);
const extensionUiKeySchema = z.string().max(EXTENSION_UI_KEY_MAX_CHARS);
const extensionUiLinesSchema = z
	.array(extensionUiTextSchema)
	.max(EXTENSION_UI_RENDERED_LINE_MAX_ITEMS)
	.superRefine((lines, context) => {
		let totalChars = 0;
		for (const line of lines) {
			totalChars += line.length;
			if (totalChars > EXTENSION_UI_TEXT_MAX_CHARS) {
				context.addIssue({ code: "custom", message: "Extension UI lines exceed their aggregate text limit" });
				return;
			}
		}
	});
const overlaySizeSchema = z.union([z.number(), z.string().regex(/^-?\d+(?:\.\d+)?%$/u)]);
const customPanelLayoutSchema = z.strictObject({
	width: overlaySizeSchema.nullable(),
	minWidth: z.number().nullable(),
	maxHeight: overlaySizeSchema.nullable(),
	anchor: z.enum([
		"center",
		"top-left",
		"top-right",
		"bottom-left",
		"bottom-right",
		"top-center",
		"bottom-center",
		"left-center",
		"right-center",
	]),
	row: overlaySizeSchema.nullable(),
	col: overlaySizeSchema.nullable(),
	offsetX: z.number(),
	offsetY: z.number(),
	margin: z
		.strictObject({
			top: z.number(),
			right: z.number(),
			bottom: z.number(),
			left: z.number(),
		})
		.nullable(),
	nonCapturing: z.boolean(),
});
const extensionUiEventSchema = z.discriminatedUnion("type", [
	z.strictObject({ type: z.literal("status"), key: extensionUiKeySchema, text: extensionUiTextSchema.nullable() }),
	z.strictObject({
		type: z.literal("widget"),
		key: extensionUiKeySchema,
		lines: extensionUiLinesSchema,
		placement: z.enum(["aboveComposer", "belowComposer"]).nullable(),
	}),
	z.strictObject({ type: z.literal("header"), lines: extensionUiLinesSchema.nullable() }),
	z.strictObject({ type: z.literal("footer"), lines: extensionUiLinesSchema.nullable() }),
	z.strictObject({ type: z.literal("workingMessage"), message: extensionUiTextSchema.nullable() }),
	z.strictObject({ type: z.literal("workingVisible"), visible: z.boolean() }),
	z.strictObject({
		type: z.literal("workingIndicator"),
		indicator: z
			.strictObject({
				frames: extensionUiLinesSchema.max(EXTENSION_UI_WORKING_FRAME_MAX_ITEMS).optional(),
				intervalMs: z.number().int().positive().optional(),
			})
			.nullable(),
	}),
	z.strictObject({
		type: z.literal("custom"),
		lines: extensionUiLinesSchema.nullable(),
		hidden: z.boolean(),
		focused: z.boolean(),
		layout: customPanelLayoutSchema.nullable(),
	}),
	z.strictObject({ type: z.literal("customVisibility"), hidden: z.boolean(), focused: z.boolean() }),
	z.strictObject({ type: z.literal("title"), title: extensionUiTextSchema.nullable() }),
	z.strictObject({ type: z.literal("editorText"), text: extensionUiTextSchema }),
	z.strictObject({ type: z.literal("voiceSettings"), requestId: z.uuid() }),
	z.strictObject({ type: z.literal("terminalInputListening"), listening: z.boolean() }),
	z.strictObject({ type: z.literal("toolsExpanded"), expanded: z.boolean() }),
	z.strictObject({ type: z.literal("hiddenThinkingLabel"), label: extensionUiTextSchema.nullable() }),
	z.strictObject({
		type: z.literal("notify"),
		level: z.enum(["info", "warning", "error"]),
		message: extensionUiTextSchema,
	}),
	z.strictObject({ type: z.literal("reset") }),
]);

const eventBaseShape = {
	protocolVersion: z.literal(PI_WORKER_PROTOCOL_VERSION),
	generation: countSchema.positive(),
	sequence: countSchema.positive(),
};
const runtimeEventEnvelopeSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		...eventBaseShape,
		kind: z.literal("runtimeEvent"),
		runtimeId: idSchema,
		event: runtimeEventSchema,
	}),
	z.strictObject({
		...eventBaseShape,
		kind: z.literal("runtimeState"),
		runtimeId: idSchema,
		state: runtimeStateSchema,
	}),
	z.strictObject({ ...eventBaseShape, kind: z.literal("runtimeBusy"), runtimeId: idSchema, busy: z.boolean() }),
	z.strictObject({
		...eventBaseShape,
		kind: z.literal("runtimeReplaced"),
		runtimeId: idSchema,
		event: z.strictObject({
			previousRef: sessionRefSchema,
			nextRef: sessionRefSchema,
			reason: z.enum(["new", "fork", "switch", "refresh"]),
		}),
		state: runtimeStateSchema,
	}),
	z.strictObject({
		...eventBaseShape,
		kind: z.literal("runtimeSnapshotChanged"),
		runtimeId: idSchema,
		ref: sessionRefSchema,
		state: runtimeStateSchema,
	}),
	z.strictObject({
		...eventBaseShape,
		kind: z.literal("runtimeTranscriptInvalidated"),
		runtimeId: idSchema,
		ref: sessionRefSchema,
		reason: z.enum(["treeNavigation", "reload"]),
		state: runtimeStateSchema,
	}),
	z.strictObject({
		...eventBaseShape,
		kind: z.literal("runtimeTranscriptProjectionChanged"),
		runtimeId: idSchema,
		ref: sessionRefSchema,
		reason: z.literal("markdownWidth"),
	}),
	z.strictObject({
		...eventBaseShape,
		kind: z.literal("runtimeLifecycleFailed"),
		runtimeId: idSchema,
		ref: sessionRefSchema,
		error: z.strictObject({
			code: fieldSchema,
			message: textSchema,
			retryable: z.boolean(),
			category: fieldSchema.optional(),
			userAction: fieldSchema.optional(),
			details: errorDetailsSchema.optional(),
		}),
		relatedRefs: z.array(sessionRefSchema).max(COLLECTION_MAX_ITEMS),
	}),
	z.strictObject({
		...eventBaseShape,
		kind: z.literal("extensionUiState"),
		runtimeId: idSchema,
		ref: sessionRefSchema,
		event: extensionUiEventSchema,
	}),
]);

export function parsePiWorkerEventPayload(value: unknown): PiWorkerEvent {
	const runtimeEvent = runtimeEventEnvelopeSchema.safeParse(value);
	return runtimeEvent.success ? (runtimeEvent.data as PiWorkerEvent) : parsePiWorkerDomainEvent(value);
}
