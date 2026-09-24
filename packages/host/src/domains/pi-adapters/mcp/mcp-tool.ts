import { z } from "zod";
import { mcpToolRequestSchema } from "@ling/contracts/mcp-tool";
import type { McpOverview, McpWriteRequest } from "@ling/contracts/mcp";
import type { SessionRef } from "@ling/contracts/session-ref";
import type { PiResourceReloadSummary } from "@ling/contracts/session";
import { parsePiWorkerSessionRef } from "@ling/core/pi-protocol/protocol-validation";
import type { BuiltinFeatureStore } from "../../companions/builtin-features";
import type { ResourceReloadCoordinator } from "../../resources/resource-reload";
import type { McpSettings } from "./mcp-settings";

// Larger inventories can be narrowed by name/target without flooding the model context.
const TOOL_SERVER_LIMIT = 100;

function inventory(overview: McpOverview, name?: string, target?: string) {
	const effective = overview.effective?.filter((entry) => name === undefined || entry.name === name) ?? null;
	return {
		documents: overview.documents
			.filter((document) => target === undefined || document.target === target)
			.map((document) => {
				const entries =
					document.servers === null
						? null
						: Object.entries(document.servers).filter(([key]) => name === undefined || key === name);
				return {
					path: document.path,
					target: document.target,
					scope: document.scope,
					exists: document.exists,
					revision: document.revision,
					error: document.error,
					// Values may contain credentials in args, URLs or arbitrary extension options. Never echo them.
					servers:
						entries?.slice(0, TOOL_SERVER_LIMIT).map(([name, entry]) => ({
							name,
							disabled: entry.disabled ?? null,
							transport: entry.command ? "stdio" : entry.url ? "http" : entry.socket ? "socket" : "override",
							fields: Object.keys(entry),
						})) ?? null,
					omitted: entries === null ? null : Math.max(0, entries.length - TOOL_SERVER_LIMIT),
				};
			}),
		effective: effective?.slice(0, TOOL_SERVER_LIMIT) ?? null,
		effectiveOmitted: effective === null ? null : Math.max(0, effective.length - TOOL_SERVER_LIMIT),
	};
}

export function createMcpTool(options: {
	settings: McpSettings;
	features: Pick<BuiltinFeatureStore, "read">;
	resources: Pick<ResourceReloadCoordinator, "reloadPiResources">;
	setFeature(enabled: boolean, expectedRevision: number, signal: AbortSignal): Promise<PiResourceReloadSummary>;
	requireManagedSession(ref: SessionRef): unknown;
}) {
	return {
		async run(value: unknown, signal: AbortSignal): Promise<string> {
			const { ref: rawRef, request } = z.strictObject({ ref: z.unknown(), request: mcpToolRequestSchema }).parse(value);
			const ref = parsePiWorkerSessionRef(rawRef);
			options.requireManagedSession(ref);
			signal.throwIfAborted();
			// This also enforces open-project/trust checks before global or feature mutations.
			const overview = await options.settings.read(ref.cwd, signal);
			options.requireManagedSession(ref);
			signal.throwIfAborted();
			let reload: PiResourceReloadSummary | undefined;
			if (request.action === "set_feature_enabled") {
				reload = await options.setFeature(request.enabled, request.expectedFeatureRevision, signal);
			} else if (request.action === "reload") {
				reload = await options.resources.reloadPiResources();
			} else if (request.action !== "read") {
				let change: McpWriteRequest["change"];
				switch (request.action) {
					case "configure":
						change = { kind: "patch", server: request.server, removeFields: request.removeFields };
						break;
					case "remove":
						change = { kind: "remove" };
						break;
					case "set_server_enabled":
						change = { kind: "toggle", disabled: !request.enabled };
						break;
					case "reset_server_enabled":
						change = { kind: "reset-disabled" };
						break;
				}
				reload = await options.settings.write(
					{
						cwd: ref.cwd,
						target: request.target,
						name: request.name,
						expectedRevision: request.expectedRevision,
						change,
					},
					signal,
				);
			}
			const feature = await options.features.read();
			return JSON.stringify({
				action: request.action,
				feature: { enabled: feature.enabled.mcp, revision: feature.revision },
				featureScope:
					"Ling bundled MCP and native controls; independently installed Pi adapters retain their own lifecycle",
				...(request.action === "read"
					? inventory(overview, request.name, request.target)
					: { saved: request.action !== "reload", reload }),
				note: "Enabling or reloading may start enabled services according to adapter lifecycle. This result does not verify a connection. Pending sessions apply changes after their current run; check MCP status/tools in the next turn. Configuration edits never change the feature switch.",
			});
		},
	};
}
