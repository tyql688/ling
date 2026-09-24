import { z } from "zod";
import { companionToolCallSchema, companionToolResultSchema, piAdapterPlanSchema } from "@ling/contracts/companions";
import { fieldSchema, idSchema, textSchema as outputTextSchema, reviewFileSchema } from "./runtime-payload-schemas";
import { controlIdSchema, controlSessionRefSchema, controlPathSchema } from "./control-schemas";
import type { ReviewSnapshotFile } from "../change-review/change-review";
import type { PiMethodInput, PiMethodOutput } from "./method";
const textSchema = fieldSchema;
const timeoutSchema = z.number().positive().optional();
const extensionPromptSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("select"),
		title: textSchema,
		options: z.array(textSchema).max(256),
		timeout: timeoutSchema,
	}),
	z.strictObject({
		kind: z.literal("input"),
		title: textSchema,
		placeholder: z.string().nullable(),
		timeout: timeoutSchema,
	}),
	z.strictObject({
		kind: z.literal("editor"),
		title: textSchema,
		initialValue: textSchema,
		timeout: timeoutSchema,
	}),
]);
const turnContextSchema = z.strictObject({ userMessageEntryId: z.string().nullable() });

const reviewFilesSchema = z
	.array(reviewFileSchema)
	.max(10_000)
	.transform((value) => value as ReviewSnapshotFile[]);
export const piCallbacks = {
	"companions.invoke": {
		input: companionToolCallSchema,
		result: (value: unknown) => companionToolResultSchema.parse(value),
	},
	"runtime.beforeBind": {
		input: z.strictObject({
			creationRequestId: controlIdSchema,
			runtimeId: controlIdSchema,
			ref: controlSessionRefSchema,
		}),
		result: (value: unknown) => {
			z.null().parse(value);
		},
	},
	"runtime.prepareReplacement": {
		input: z.strictObject({
			runtimeId: controlIdSchema,
			event: z.strictObject({
				previousRef: controlSessionRefSchema,
				nextRef: controlSessionRefSchema,
				reason: z.enum(["new", "fork", "switch", "refresh"]),
			}),
		}),
		result: (value: unknown) => {
			return z.strictObject({ reservationId: idSchema }).parse(value);
		},
	},
	"runtime.commitReplacement": {
		input: z.strictObject({ reservationId: controlIdSchema }),
		result: (value: unknown) => {
			z.null().parse(value);
		},
	},
	"runtime.abortReplacement": {
		input: z.strictObject({ reservationId: controlIdSchema }),
		result: (value: unknown) => {
			z.null().parse(value);
		},
	},
	"extension.confirm": {
		input: z.strictObject({
			ref: controlSessionRefSchema,
			title: textSchema,
			message: textSchema,
			timeout: timeoutSchema,
		}),
		result: (value: unknown) => {
			return z.boolean().parse(value);
		},
	},
	"extension.prompt": {
		input: z.strictObject({ ref: controlSessionRefSchema, prompt: extensionPromptSchema }),
		result: (value: unknown) => {
			return outputTextSchema.nullable().parse(value);
		},
	},
	"turn.start": {
		input: z.strictObject({
			ref: controlSessionRefSchema,
			timestamp: z.number().int().positive(),
			context: turnContextSchema,
		}),
		result: (value: unknown) => {
			z.null().parse(value);
		},
	},
	"turn.finish": {
		input: z.strictObject({
			ref: controlSessionRefSchema,
			timestamp: z.number().int().positive(),
			fallback: z.strictObject({
				files: reviewFilesSchema,
				failureCode: z.enum(["CAPTURE_FAILED", "DIFF_LIMIT_EXCEEDED", "TURN_LIMIT_EXCEEDED"]).nullable(),
			}),
			context: turnContextSchema,
		}),
		result: (value: unknown) => {
			z.null().parse(value);
		},
	},
	"mcp.manage": {
		input: z.unknown(),
		result: (value: unknown) => outputTextSchema.parse(value),
	},
	"plugins.run": {
		input: z.unknown(),
		result: (value: unknown) => {
			return outputTextSchema.parse(value);
		},
	},
	"adapters.read": {
		input: z.strictObject({ cwd: controlPathSchema }),
		result: (value: unknown) => piAdapterPlanSchema.parse(value),
	},
	"project.promptTrust": {
		input: z.strictObject({ cwd: controlPathSchema }),
		result: (value: unknown) => {
			return z.enum(["trust", "session", "deny"]).nullable().parse(value);
		},
	},
};
export type PiWorkerMainMethod = keyof typeof piCallbacks;
export const PI_WORKER_MAIN_METHODS = Object.keys(piCallbacks) as PiWorkerMainMethod[];
export type PiCallbackInput<Method extends PiWorkerMainMethod> = PiMethodInput<(typeof piCallbacks)[Method]>;
export type PiCallbackResult<Method extends PiWorkerMainMethod> = PiMethodOutput<(typeof piCallbacks)[Method]>;
export type PiWorkerCallMain = <Method extends PiWorkerMainMethod>(
	method: Method,
	params: PiCallbackInput<Method>,
	options?: { timeoutMs?: number | null; signal?: AbortSignal },
) => Promise<PiCallbackResult<Method>>;
export function parsePiWorkerMainOperationResult(method: PiWorkerMainMethod, value: unknown): unknown {
	return piCallbacks[method].result(value);
}
