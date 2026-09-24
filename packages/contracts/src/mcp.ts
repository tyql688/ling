import { z } from "zod";
import { portableAbsolutePathSchema } from "./path-validation";
import type { SessionRuntimeBindingRequest } from "./session-extension-ui";

export const MCP_PACKAGE = "pi-mcp-adapter";
export const MCP_BUNDLED_SOURCE = "ling:mcp";
// Configuration is user-authored, but still crosses the file and RPC boundaries.
export const MCP_CONFIG_MAX_BYTES = 1024 * 1024;
export const MCP_SERVER_LIMIT = 512;
export const mcpServerNameSchema = z
	.string()
	.min(1)
	.max(200)
	.refine(
		(value) =>
			value.trim().length > 0 && [...value].every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127),
		"Invalid MCP server name",
	);
const text = z.string().max(16_384);
const dictionary = z.record(z.string().max(256), text);
const httpUrl = z.url({ protocol: /^https?$/ });
const serverUrl = text.min(1).refine((value) => {
	// Pi resolves these references at connection time; configuration editing must not expand secrets.
	if (/^(?:\$\{\w+\}|\$env:\w+|\{env:\w+\})$/.test(value)) return true;
	return httpUrl.safeParse(value.replace(/\$\{\w+\}|\$env:\w+|\{env:\w+\}/g, "placeholder")).success;
}, "Expected an HTTP(S) URL or an environment variable reference");

/** Partial entries deliberately support project overrides such as { disabled: true }. */
export const mcpServerSchema = z
	.object({
		command: text.min(1).optional(),
		args: z.array(text).max(256).optional(),
		url: serverUrl.optional(),
		socket: text.min(1).optional(),
		cwd: text.optional(),
		env: dictionary.optional(),
		headers: dictionary.optional(),
		disabled: z.boolean().optional(),
		directTools: z.union([z.boolean(), z.literal("search"), z.array(text).max(4096)]).optional(),
		approveTools: z.union([z.boolean(), z.array(text).max(4096)]).optional(),
		lifecycle: z.enum(["keep-alive", "lazy", "lazy-keep-alive", "eager"]).optional(),
		httpTransport: z.enum(["streamable-http", "sse"]).optional(),
	})
	.catchall(z.json())
	.superRefine((entry, context) => {
		if ([entry.command, entry.url, entry.socket].filter(Boolean).length > 1)
			context.addIssue({ code: "custom", message: "Choose one MCP transport: command, URL or socket." });
	});
export type McpServer = z.infer<typeof mcpServerSchema>;
const serverMap = z
	.record(z.string().max(200), mcpServerSchema)
	.refine((servers) => Object.keys(servers).length <= MCP_SERVER_LIMIT, "Too many MCP servers");
export const mcpConfigSchema = z
	.object({
		mcpServers: serverMap.optional(),
		"mcp-servers": serverMap.optional(),
		settings: z.record(z.string(), z.json()).optional(),
		imports: z.array(z.string()).optional(),
	})
	.catchall(z.json());

export const mcpTargetSchema = z.enum(["global", "global-shared", "project", "project-shared"]);
export type McpTarget = z.infer<typeof mcpTargetSchema>;
export const mcpPatchSchema = z.strictObject({
	kind: z.literal("patch"),
	server: mcpServerSchema.refine(
		(server) => !Object.hasOwn(server, "mcpServers") && !Object.hasOwn(server, "mcp-servers"),
		"Provide one MCP service, not a whole configuration document",
	),
	// Explicit removal lets a caller change transport without reconstructing credential-bearing fields.
	removeFields: z.array(z.string().min(1).max(256)).max(64).default([]),
});
export const mcpReadRequestSchema = z.strictObject({ cwd: portableAbsolutePathSchema("Project path").nullable() });
export const mcpWriteRequestSchema = z
	.strictObject({
		cwd: portableAbsolutePathSchema("Project path").nullable(),
		target: mcpTargetSchema,
		expectedRevision: z.string().length(64),
		name: mcpServerNameSchema,
		change: z.discriminatedUnion("kind", [
			z.strictObject({ kind: z.literal("save"), server: mcpServerSchema }),
			mcpPatchSchema,
			z.strictObject({ kind: z.literal("toggle"), disabled: z.boolean() }),
			z.strictObject({ kind: z.literal("reset-disabled") }),
			z.strictObject({ kind: z.literal("remove") }),
		]),
	})
	.refine((input) => !input.target.startsWith("project") || input.cwd !== null, "Select a project first");
export type McpWriteRequest = z.infer<typeof mcpWriteRequestSchema>;

/** Worker reconciliation scope; null retains the conservative all-project reload. */
export const mcpWriteResultSchema = z.strictObject({
	changed: z.boolean(),
	// Match the Pi worker's open-project admission capacity.
	reloadProjects: z.array(portableAbsolutePathSchema("Project path")).max(64).nullable(),
});
export type McpWriteResult = z.infer<typeof mcpWriteResultSchema>;

export const mcpCommandSchema = z.strictObject({
	action: z.enum(["connect", "authenticate"]),
	// Upstream's reconnect command splits its target on whitespace.
	name: mcpServerNameSchema.refine((name) => !/\s/.test(name), "MCP commands require a name without whitespace"),
});
export type McpCommand = z.infer<typeof mcpCommandSchema>;
export type McpCommandRequest = McpCommand & SessionRuntimeBindingRequest;

export const mcpDocumentSchema = z.strictObject({
	path: z.string(),
	scope: z.enum(["global", "project"]),
	target: mcpTargetSchema.nullable(),
	exists: z.boolean(),
	revision: z.string().nullable(),
	servers: z.record(z.string(), mcpServerSchema).nullable(),
	error: z.string().nullable(),
});
export type McpDocument = z.infer<typeof mcpDocumentSchema>;
export const mcpOverviewSchema = z.strictObject({
	documents: z.array(mcpDocumentSchema).max(64),
	effective: z
		.array(
			z.strictObject({
				name: z.string(),
				disabled: z.boolean(),
				transport: z.enum(["stdio", "http", "socket", "override"]),
				source: z.string().nullable(),
			}),
		)
		.max(MCP_SERVER_LIMIT)
		.nullable(),
});
export type McpOverview = z.infer<typeof mcpOverviewSchema>;

/** Only live, versioned upstream status is projected; cached catalogs are not connections. */
export const mcpStatusSchema = z.object({
	version: z.literal(1),
	servers: z
		.array(
			z.object({
				name: z.string().max(200),
				status: z.enum(["connected", "cached", "failed", "needs-auth", "not-connected", "disabled"]),
				toolCount: z.number().int().nonnegative(),
				directToolCount: z.number().int().nonnegative(),
				disabled: z.boolean(),
			}),
		)
		.max(MCP_SERVER_LIMIT),
	totalTools: z.number().int().nonnegative(),
	connectedCount: z.number().int().nonnegative(),
});
export type McpStatus = z.infer<typeof mcpStatusSchema>;

export function isPiMcpSource(source: string): boolean {
	return (
		source === MCP_BUNDLED_SOURCE ||
		source === `npm:${MCP_PACKAGE}` ||
		/^(?:git:)?(?:https?:\/\/|git@)?github\.com[/:]nicobailon\/pi-mcp-adapter(?:\.git)?(?:@[^/]+)?\/?$/.test(source)
	);
}
