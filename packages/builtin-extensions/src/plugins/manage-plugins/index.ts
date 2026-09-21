import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PLUGIN_SOURCE_MAX_CHARS } from "@ling/contracts/plugin";
import { pluginToolRequestSchema, type PluginToolRequest } from "@ling/contracts/plugin-validation";
import type { SessionRef } from "@ling/contracts/session-ref";
import { Type } from "typebox";

export type PluginToolHost = (ref: SessionRef, request: PluginToolRequest, signal?: AbortSignal) => Promise<string>;

export function createPluginTools(host: PluginToolHost): (pi: ExtensionAPI) => void {
	return (pi) => {
		pi.registerTool({
			name: "ling_plugins",
			label: "Pi plugins",
			description:
				"List, install, remove, check updates, or update Pi packages through Ling's embedded package manager. " +
				"Use action=list to inspect configured packages and active resource counts; source and scope optionally filter the list. " +
				"Use action=install with the user's package source (npm, Git URL, or local path). " +
				"Installation defaults to global scope; project scope requires trust. " +
				"For remove, pass an installed source/path and explicit global or project scope. " +
				"For check_updates, optional source/scope filter positive update matches; empty results do not prove all packages are current. " +
				"For update, require an installed source (or explicit null for every package) and scope global, project, or all. " +
				"Pi updates can affect the same package identity across trusted scopes; inspect scopePrecision in the result. " +
				"Mutations reconcile open projects and sessions automatically. Busy sessions reload after their run ends. " +
				"Only perform package changes requested by the user.",
			promptSnippet: "Inspect, install, remove, and update Pi plugin packages directly in Ling.",
			executionMode: "sequential",
			parameters: Type.Object({
				// Pi's Google adapter requires string enums rather than anyOf/const alternatives.
				action: Type.String({ enum: ["list", "install", "remove", "check_updates", "update"] }),
				source: Type.Optional(
					Type.Union([Type.String({ minLength: 1, maxLength: PLUGIN_SOURCE_MAX_CHARS }), Type.Null()]),
				),
				scope: Type.Optional(Type.String({ enum: ["global", "project", "all"] })),
			}),
			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				signal?.throwIfAborted();
				const request = pluginToolRequestSchema.parse(params);
				const text = await host({ cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId() }, request, signal);
				return { content: [{ type: "text", text }], details: undefined };
			},
		});
	};
}
