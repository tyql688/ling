import { z } from "zod";
import { sessionRefSchema } from "./session-ref";
import { sessionToolFilterSchema } from "./session-tool-filter";

/** Pages bound tree projection work; large tool bodies stay in the transcript reader. */
export const SESSION_TREE_PAGE_SIZE = 100;
/** Import/export is explicit and bounded independently of a chat message. */
export const SESSION_TRANSFER_MAX_BYTES = 8 * 1024 * 1024;
const id = z.string().min(1).max(1024);
export const sessionInspectionQuerySchema = z.strictObject({ offset: z.number().int().nonnegative().default(0) });
export const sessionInspectionBindingSchema = z.strictObject({
	ref: sessionRefSchema,
	runtimeId: id,
	generation: z.number().int().nonnegative(),
});
export const sessionInspectionSchema = z.strictObject({
	leafId: id.nullable(),
	busy: z.boolean(),
	toolFilter: sessionToolFilterSchema,
	total: z.number().int().nonnegative(),
	offset: z.number().int().nonnegative(),
	entries: z
		.array(
			z.strictObject({
				id,
				parentId: id.nullable(),
				branchDepth: z.number().int().nonnegative(),
				onCurrentBranch: z.boolean(),
				type: z.string(),
				role: z.string().nullable(),
				text: z.string().max(512),
				timestamp: z.string(),
				label: z.string().nullable(),
			}),
		)
		.max(SESSION_TREE_PAGE_SIZE),
	tools: z.array(z.strictObject({ name: id, description: z.string().max(4096), active: z.boolean() })).max(10_000),
	flags: z
		.array(
			z.strictObject({
				name: id,
				description: z.string().max(4096),
				type: z.enum(["string", "boolean"]),
				value: z.union([z.string(), z.boolean()]).nullable(),
			}),
		)
		.max(10_000),
	systemPrompt: z.string().max(1024 * 1024),
	systemPromptTruncated: z.boolean(),
	context: z
		.strictObject({ tokens: z.number().nullable(), contextWindow: z.number(), percent: z.number().nullable() })
		.nullable(),
	cache: z
		.strictObject({
			state: z.enum(["inactive", "scheduled", "refreshing"]),
			reason: z.string().nullable(),
			nextWarmAt: z.number().nullable(),
			warmCost: z.number().nullable(),
			expectedSavings: z.number().nullable(),
			extensionOverride: z.boolean(),
		})
		.nullable(),
});
export const sessionControlSchema = z.discriminatedUnion("type", [
	z.strictObject({ type: z.literal("toolFilter"), filter: sessionToolFilterSchema }),
	z.strictObject({ type: z.literal("tool"), name: id, enabled: z.boolean() }),
	z.strictObject({ type: z.literal("flag"), name: id, value: z.union([z.string().max(65_536), z.boolean()]) }),
	z.strictObject({ type: z.literal("label"), entryId: id, label: z.string().max(4096) }),
	z.strictObject({
		type: z.literal("navigate"),
		entryId: id,
		summarize: z.boolean(),
		customInstructions: z.string().max(65_536).optional(),
	}),
]);
export const sessionControlResultSchema = z.strictObject({ cancelled: z.boolean(), editorText: z.string().optional() });
export const sessionExportFormatSchema = z.enum(["html", "jsonl"]);
export const sessionExportResultSchema = z.strictObject({
	name: z.string(),
	content: z.string().max(SESSION_TRANSFER_MAX_BYTES),
	mimeType: z.string(),
});
export type SessionInspection = z.infer<typeof sessionInspectionSchema>;
export type SessionControl = z.infer<typeof sessionControlSchema>;
export type SessionInspectionBinding = z.infer<typeof sessionInspectionBindingSchema>;
