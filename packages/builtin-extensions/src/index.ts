import { createMcpTools, type McpToolHost } from "./plugins/manage-mcp/index.ts";
import type { BuiltinFeatureFlags } from "@ling/contracts/builtin-features";
import { createCompanionTools, type CompanionToolHost } from "./plugins/companion-tools/index.ts";
import { createPluginTools, type PluginToolHost } from "./plugins/manage-plugins/index.ts";
export { createImageGenerationExtension } from "./plugins/generate-image/index.ts";

/** Pi loads inline factories after user extensions; register Host-backed capabilities. */
export function lingExtensionFactories(
	pluginTools: PluginToolHost,
	companionTools: CompanionToolHost,
	features: BuiltinFeatureFlags,
	mcpTools: McpToolHost,
): { name: string; factory: ReturnType<typeof createPluginTools> }[] {
	return [
		{ name: "ling-mcp", factory: createMcpTools(mcpTools) },
		{ name: "ling-plugins", factory: createPluginTools(pluginTools) },
		{ name: "ling-companions", factory: createCompanionTools(companionTools, features) },
	];
}
