import { z } from "zod";
import { controlFreeString } from "./schema-primitives";
import { RESERVED_OBJECT_KEYS } from "./text-validation";
import { PLUGIN_SOURCE_MAX_CHARS } from "./plugin";

/** Plugin sources reuse the reserved-key set: prototype-pollution strings must not reach an install. */
export const pluginSourceSchema = controlFreeString(PLUGIN_SOURCE_MAX_CHARS, "Plugin source")
	.transform((value) => value.trim())
	.refine((value) => !RESERVED_OBJECT_KEYS.has(value), "Plugin source is reserved")
	.refine((value) => !value.startsWith("-"), "Plugin source must not be option-like");

export const pluginToolRequestSchema = z.discriminatedUnion("action", [
	z.strictObject({
		action: z.literal("list"),
		source: pluginSourceSchema.optional(),
		scope: z.enum(["global", "project"]).optional(),
	}),
	z.strictObject({
		action: z.literal("install"),
		source: pluginSourceSchema,
		scope: z.enum(["global", "project"]).default("global"),
	}),
	z.strictObject({
		action: z.literal("remove"),
		source: pluginSourceSchema,
		scope: z.enum(["global", "project"]),
	}),
	z.strictObject({
		action: z.literal("check_updates"),
		source: pluginSourceSchema.optional(),
		scope: z.enum(["global", "project"]).optional(),
	}),
	z.strictObject({
		action: z.literal("update"),
		// Null explicitly selects every package; omitted sources must never become a bulk update.
		source: pluginSourceSchema.nullable(),
		scope: z.enum(["global", "project", "all"]),
	}),
]);

export type PluginToolRequest = z.infer<typeof pluginToolRequestSchema>;
