import { z } from "zod";
import { builtinFeatureFlagsSchema } from "./builtin-features";
import { portableAbsolutePathSchema } from "./path-validation";
import { piToolOriginSchema } from "./pi-tool-origin";
import { THINKING_LEVELS } from "./session";
import { sessionRefSchema } from "./session-ref";

const id = z.string().min(1).max(200);
const text = z.string().max(65_536);

export const toolResultSnapshotSchema = z.strictObject({
	toolCallId: id,
	origin: piToolOriginSchema.nullable(),
	details: z.json(),
	isError: z.boolean(),
});
export type ToolResultSnapshot = z.infer<typeof toolResultSnapshotSchema>;

interface InteractionQuestion {
	id: string;
	title: string;
	multiple?: boolean | undefined;
	options?: { id: string; label: string; description?: string | undefined }[] | undefined;
}
/** A question or approval a Host feature is waiting on; the user answers it in the conversation. */
export interface Interaction {
	id: string;
	feature: string;
	ref: z.infer<typeof sessionRefSchema>;
	kind: "questions" | "approval";
	title: string;
	body: string;
	questions: InteractionQuestion[];
	createdAt: number;
}
export type InteractionRequest = Pick<Interaction, "ref" | "kind" | "title"> & {
	body?: string | undefined;
	questions?: InteractionQuestion[];
};
export const interactionAnswerSchema = z.strictObject({
	status: z.enum(["answered", "skipped"]),
	answers: z.array(z.strictObject({ id, selected: z.array(id).max(12), text: z.string().max(16_384) })).max(8),
	approved: z.boolean().optional(),
});
export type InteractionAnswer = z.infer<typeof interactionAnswerSchema>;

export const companionRunSchema = z.strictObject({
	runId: id,
	ref: sessionRefSchema,
	status: z.enum(["running", "completed", "failed", "cancelled", "interrupted"]),
	error: text.nullable(),
	tokens: z.number().nonnegative(),
	text,
});
export type CompanionRun = z.infer<typeof companionRunSchema>;
export const thinkingLevelSchema = z.enum(THINKING_LEVELS);
export const companionRunRequestSchema = z.strictObject({
	cwd: portableAbsolutePathSchema("Project path"),
	sessionId: id.optional(),
	requestId: id,
	prompt: text.min(1),
	title: id.optional(),
	model: z.strictObject({ provider: id, id }).optional(),
	thinking: thinkingLevelSchema.optional(),
});
export type CompanionRunRequest = z.infer<typeof companionRunRequestSchema>;
export type CompanionRunAdmission = { status: "busy" } | { status: "started"; run: CompanionRun };

/** One tool call from the agent, executed by the Host feature that owns the tool. */
export const companionToolCallSchema = z.strictObject({
	name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,99}$/),
	ref: sessionRefSchema,
	input: z.json(),
});
export type CompanionToolCall = z.infer<typeof companionToolCallSchema>;
export const companionToolResultSchema = z.strictObject({
	content: z
		.array(z.strictObject({ type: z.literal("text"), text: z.string().max(262_144) }))
		.min(1)
		.max(16),
	details: z.json(),
});
export type CompanionToolResult = z.infer<typeof companionToolResultSchema>;

/** Bundled Pi package entries the Host resolved, and whether the permission system applies to the project. */
export const piAdapterPlanSchema = z.strictObject({
	features: builtinFeatureFlagsSchema,
	todo: z.string().min(1).nullable(),
	voice: z.string().min(1).nullable(),
	permissions: z.strictObject({ entry: z.string().min(1), enabled: z.boolean() }).nullable(),
});
export type PiAdapterPlan = z.infer<typeof piAdapterPlanSchema>;
