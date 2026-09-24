import { z } from "zod";
import { mcpPatchSchema, mcpServerNameSchema, mcpTargetSchema } from "./mcp";

const entry = {
	target: mcpTargetSchema,
	expectedRevision: z.string().length(64),
	name: mcpServerNameSchema,
};

/** The session owns cwd; model arguments select only a configuration layer within that project. */
export const mcpToolRequestSchema = z.discriminatedUnion("action", [
	z.strictObject({
		action: z.literal("read"),
		name: mcpServerNameSchema.optional(),
		target: mcpTargetSchema.optional(),
	}),
	z.strictObject({ action: z.literal("configure"), ...entry, ...mcpPatchSchema.omit({ kind: true }).shape }),
	z.strictObject({ action: z.literal("remove"), ...entry }),
	z.strictObject({ action: z.literal("set_server_enabled"), ...entry, enabled: z.boolean() }),
	z.strictObject({ action: z.literal("reset_server_enabled"), ...entry }),
	z.strictObject({
		action: z.literal("set_feature_enabled"),
		enabled: z.boolean(),
		expectedFeatureRevision: z.number().int().nonnegative(),
	}),
	z.strictObject({ action: z.literal("reload") }),
]);
export type McpToolRequest = z.infer<typeof mcpToolRequestSchema>;
