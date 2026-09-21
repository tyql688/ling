import { createPluginRequestSchemas } from "@ling/contracts/plugin-requests";
import { absolutePathSchema } from "@ling/core/paths";
export const { installPluginRequestSchema, removePluginRequestSchema, updatePluginRequestSchema } =
	createPluginRequestSchemas(absolutePathSchema("Plugin project path"));
