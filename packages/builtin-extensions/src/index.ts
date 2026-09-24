import { createMcpTools, type McpToolHost } from "./plugins/manage-mcp/index.ts";
import bashGuard from "./plugins/bash-guard/index.ts";
import type { BuiltinFeatureFlags } from "@ling/contracts/builtin-features";
import { createCompanionTools, type CompanionToolHost } from "./plugins/companion-tools/index.ts";
import { createPluginTools, type PluginToolHost } from "./plugins/manage-plugins/index.ts";

/** Pi loads inline factories after user extensions; register Ling policy and Host-backed capabilities. */
export function lingExtensionFactories(
	pluginTools: PluginToolHost,
	companionTools: CompanionToolHost,
	features: BuiltinFeatureFlags,
	mcpTools: McpToolHost,
): { name: string; factory: typeof bashGuard }[] {
	return [
		{ name: "ling-bash-guard", factory: bashGuard },
		{ name: "ling-mcp", factory: createMcpTools(mcpTools) },
		{ name: "ling-plugins", factory: createPluginTools(pluginTools) },
		{ name: "ling-companions", factory: createCompanionTools(companionTools, features) },
	];
}
