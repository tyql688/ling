import { portableAbsolutePathSchema } from "./path-validation";
import { operationRefSchema } from "./owner-ref";
import { strictObject } from "./schema-primitives";
import { pluginSourceSchema } from "./plugin-validation";
import { z } from "zod";
/** Native hosts supply their path rules here; all request fields keep one definition. */
export function createPluginRequestSchemas(pluginCwdSchema = portableAbsolutePathSchema("Plugin project path")) {
	const pluginScopeSchema = z.enum(["global", "project"]);

	const pluginProjectRequestSchema = strictObject({ cwd: pluginCwdSchema });

	const installPluginRequestSchema = strictObject({
		operation: operationRefSchema,
		deadlineAt: z.number().int().positive(),
		cwd: pluginCwdSchema,
		source: pluginSourceSchema,
		scope: pluginScopeSchema,
	});

	const removePluginRequestSchema = strictObject({
		operation: operationRefSchema,
		deadlineAt: z.number().int().positive(),
		cwd: pluginCwdSchema,
		source: pluginSourceSchema,
		scope: pluginScopeSchema,
	});

	const updatePluginRequestSchema = strictObject({
		operation: operationRefSchema,
		deadlineAt: z.number().int().positive(),
		cwd: pluginCwdSchema,
		/** Null updates every configured package in the explicit scope. */
		source: pluginSourceSchema.nullable(),
		scope: z.union([pluginScopeSchema, z.literal("all")]),
	});

	const cancelPluginOperationRequestSchema = strictObject({
		operation: operationRefSchema,
	});

	return {
		pluginProjectRequestSchema,
		installPluginRequestSchema,
		removePluginRequestSchema,
		updatePluginRequestSchema,
		cancelPluginOperationRequestSchema,
	};
}
