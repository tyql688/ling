import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { mcpToolRequestSchema, type McpToolRequest } from "@ling/contracts/mcp-tool";
import type { SessionRef } from "@ling/contracts/session-ref";

export type McpToolHost = (ref: SessionRef, request: McpToolRequest, signal?: AbortSignal) => Promise<string>;

/** Management remains available when execution is off, just like the MCP settings page. */
export function createMcpTools(host: McpToolHost): (pi: ExtensionAPI) => void {
	return (pi) =>
		pi.registerTool({
			name: "ling_mcp",
			label: "MCP settings",
			executionMode: "sequential",
			description:
				"Manage MCP configuration through Ling. Available even when built-in MCP is off. " +
				"Read first for the feature switch, file revisions and credential-free service inventory. " +
				"Use configure to merge server fields into an explicit target; env and headers merge by key. " +
				"removeFields deletes fields before merging, for example command and args when switching to a URL. " +
				"Changing the connection target requires explicitly removing old connection-bound fields before providing replacements. " +
				"Other values and credentials are preserved; new services default to approveTools:true. " +
				"All service mutations require the target's expectedRevision. Targets: global (Pi), global-shared, project (Pi override), project-shared. " +
				"set_server_enabled changes one service; reset_server_enabled removes that layer's disabled override. " +
				"set_feature_enabled changes Ling's global MCP switch using expectedFeatureRevision, only when the user requested activation/deactivation. " +
				"Saving configuration does not enable MCP. Enabling or reloading can connect enabled services according to adapter lifecycle. " +
				"The switch does not disable independently installed Pi adapters. " +
				"Mutations reload affected projects/sessions; busy sessions defer until the run ends. Use reload after manual edits. " +
				"Report saved, pending, failed and connected separately. Use mcp for live discovery/calls after activation. " +
				"Only make requested changes. Prefer environment references to secret values. When available, use the ling-and-pi skill for the complete workflow.",
			promptSnippet: "Configure MCP services and Ling's MCP switch, including while execution is disabled.",
			// A flat provider-facing schema avoids anyOf action variants rejected by some model APIs.
			parameters: Type.Object({
				action: Type.String({
					enum: [
						"read",
						"configure",
						"remove",
						"set_server_enabled",
						"reset_server_enabled",
						"set_feature_enabled",
						"reload",
					],
				}),
				target: Type.Optional(Type.String({ enum: ["global", "global-shared", "project", "project-shared"] })),
				name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
				expectedRevision: Type.Optional(Type.String({ minLength: 64, maxLength: 64 })),
				expectedFeatureRevision: Type.Optional(Type.Integer({ minimum: 0 })),
				enabled: Type.Optional(Type.Boolean()),
				server: Type.Optional(
					Type.Object(
						{},
						{
							additionalProperties: true,
							description:
								"Partial MCP service configuration: command/args or url, env, headers, approveTools and other adapter fields.",
						},
					),
				),
				removeFields: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 64 })),
			}),
			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				signal?.throwIfAborted();
				const request = mcpToolRequestSchema.parse(params);
				const text = await host({ cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId() }, request, signal);
				return { content: [{ type: "text", text }], details: undefined };
			},
		});
}
