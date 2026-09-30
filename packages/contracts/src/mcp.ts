import { z } from "zod";
import { portableAbsolutePathSchema } from "./path-validation";
import type { SessionRuntimeBindingRequest } from "./session-extension-ui";

export const MCP_BUILTIN_SOURCE = "builtin:mcp";
// Configuration and status cross file and RPC boundaries with bounded retained data.
export const MCP_CONFIG_MAX_BYTES = 1024 * 1024;
const MCP_SERVER_LIMIT = 512;
export const MCP_STATUS_MAX_CHARS = 262_144;
// Removal must also accept invalid stored names; the file size bounds their maximum length.
export const mcpStoredServerNameSchema = z.string().max(MCP_CONFIG_MAX_BYTES);
export const mcpServerNameSchema = z
	.string()
	.min(1)
	.max(200)
	.regex(/^[A-Za-z0-9_-]+$/);
export const mcpExposureSchema = z.enum(["codemode", "codemode-deferred", "deferred", "direct", "hidden"]);
const text = z.string().max(16_384);
const dictionary = z.record(z.string().max(256), text);
const httpUrl = z.url({ protocol: /^https?$/ });
const oauthSchema = z
	.object({
		clientId: text.optional(),
		clientSecret: text.optional(),
		callbackPort: z.number().int().min(1).max(65535).optional(),
		callbackUrl: text
			.refine((value) => {
				if (!URL.canParse(value)) return false;
				const url = new URL(value);
				return (
					url.protocol === "http:" &&
					["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
					!url.search &&
					!url.hash
				);
			}, "OAuth callback must use an HTTP loopback URL without a query or fragment")
			.optional(),
		scope: text.optional(),
	})
	.catchall(z.json())
	.superRefine((oauth, context) => {
		if (oauth.callbackPort === undefined || !oauth.callbackUrl || !URL.canParse(oauth.callbackUrl)) return;
		const port = new URL(oauth.callbackUrl).port;
		if (port && Number(port) !== oauth.callbackPort)
			context.addIssue({
				code: "custom",
				path: ["callbackPort"],
				message: "OAuth callbackUrl and callbackPort must use the same port.",
			});
	});

/** A patch can omit connection fields; a saved entry must describe one complete server. */
export const mcpServerSchema = z
	.object({
		type: z.enum(["stdio", "http", "streamable-http"]).optional(),
		command: text.min(1).optional(),
		args: z.array(text).max(256).optional(),
		url: httpUrl.optional(),
		cwd: text.optional(),
		env: dictionary.optional(),
		headers: dictionary.optional(),
		oauth: oauthSchema.optional(),
		enabled: z.boolean().optional(),
		exposure: mcpExposureSchema.optional(),
		toolExposure: z.record(z.string().max(256), mcpExposureSchema).optional(),
		timeout: z.number().positive().optional(),
	})
	.catchall(z.json());
export type McpServer = z.infer<typeof mcpServerSchema>;
export const mcpConfiguredServerSchema = mcpServerSchema.superRefine((entry, context) => {
	if (Number(!!entry.command) + Number(!!entry.url) !== 1)
		context.addIssue({ code: "custom", message: "Provide exactly one connection: command or HTTP URL." });
	if ((entry.command && entry.type && entry.type !== "stdio") || (entry.url && entry.type === "stdio"))
		context.addIssue({ code: "custom", message: "The transport type must match the connection." });
	// Silently ignoring these options can enable a disabled service or discard its approval policy.
	const legacy = [
		"disabled",
		"directTools",
		"approveTools",
		"lifecycle",
		"httpTransport",
		"socket",
		"auth",
		"bearerToken",
		"bearerTokenEnv",
		"bearerTokenStore",
		"requestHeadersCommand",
		"caFile",
		"literalEnv",
		"idleTimeout",
		"toolTimeout",
		"toolPrefix",
	];
	for (const field of legacy)
		if (Object.hasOwn(entry, field))
			context.addIssue({
				code: "custom",
				path: [field],
				message: `${field} is not supported by official Pi MCP. Use enabled, exposure and Ling access-mode rules.`,
			});
});
// Retain invalid entries for repair; one bad server must not erase valid siblings.
export const mcpConfigSchema = z
	.object({
		mcpServers: z
			.record(z.string(), z.json())
			.refine((servers) => Object.keys(servers).length <= MCP_SERVER_LIMIT, "Too many MCP servers")
			.optional(),
		autoEnableCodemode: z.json().optional(),
	})
	.catchall(z.json());
export type McpStoredServer = z.infer<ReturnType<typeof z.json>>;

export const mcpTargetSchema = z.enum(["global", "project"]);
export type McpTarget = z.infer<typeof mcpTargetSchema>;
export const mcpPatchSchema = z.strictObject({
	kind: z.literal("patch"),
	server: mcpServerSchema.refine(
		(server) => !Object.hasOwn(server, "mcpServers") && !Object.hasOwn(server, "mcp-servers"),
		"Provide one MCP service, not a whole configuration document",
	),
	removeFields: z.array(z.string().min(1).max(256)).max(64).default([]),
});
export const mcpReadRequestSchema = z.strictObject({ cwd: portableAbsolutePathSchema("Project path").nullable() });
export const mcpWriteRequestSchema = z
	.strictObject({
		cwd: portableAbsolutePathSchema("Project path").nullable(),
		target: mcpTargetSchema,
		expectedRevision: z.string().length(64),
		name: mcpStoredServerNameSchema,
		change: z.discriminatedUnion("kind", [
			z.strictObject({ kind: z.literal("save"), server: mcpConfiguredServerSchema }),
			mcpPatchSchema,
			z.strictObject({ kind: z.literal("toggle"), enabled: z.boolean() }),
			z.strictObject({ kind: z.literal("reset-enabled") }),
			z.strictObject({ kind: z.literal("remove") }),
		]),
	})
	.refine((input) => input.target !== "project" || input.cwd !== null, "Select a project first")
	.refine(
		(input) => input.change.kind === "remove" || mcpServerNameSchema.safeParse(input.name).success,
		"Use letters, digits, _ and - in server names.",
	);
export type McpWriteRequest = z.infer<typeof mcpWriteRequestSchema>;
export const mcpWriteResultSchema = z.strictObject({
	changed: z.boolean(),
	// Match the Pi worker's open-project admission capacity.
	reloadProjects: z.array(portableAbsolutePathSchema("Project path")).max(64).nullable(),
});
export type McpWriteResult = z.infer<typeof mcpWriteResultSchema>;
export const mcpCommandSchema = z.discriminatedUnion("action", [
	z.strictObject({ action: z.literal("status") }),
	z.strictObject({ action: z.enum(["connect", "authenticate", "logout"]), name: mcpServerNameSchema }),
]);
export type McpCommand = z.infer<typeof mcpCommandSchema>;
export type McpCommandRequest = McpCommand & SessionRuntimeBindingRequest;
const mcpDocumentSchema = z.strictObject({
	path: z.string(),
	scope: z.enum(["global", "project"]),
	target: mcpTargetSchema.nullable(),
	exists: z.boolean(),
	revision: z.string().nullable(),
	servers: z.record(z.string(), z.json()).nullable(),
	error: z.string().nullable(),
});
export type McpDocument = z.infer<typeof mcpDocumentSchema>;
export const mcpOverviewSchema = z.strictObject({
	documents: z.array(mcpDocumentSchema).max(64),
	// Both canonical files may contribute entries and file-level diagnostics.
	notices: z.array(z.string()).max(MCP_SERVER_LIMIT * 2 + 16),
	effective: z
		.array(
			z.strictObject({
				name: z.string(),
				disabled: z.boolean(),
				transport: z.enum(["stdio", "http"]),
				exposure: mcpExposureSchema,
				source: z.string(),
			}),
		)
		.max(MCP_SERVER_LIMIT * 2),
});
export type McpOverview = z.infer<typeof mcpOverviewSchema>;

/** The public /mcp command owns connection reporting; its text is displayed without inferring state. */
export const mcpStatusSchema = z.strictObject({
	version: z.literal(2),
	text: z.string().max(MCP_STATUS_MAX_CHARS),
	updatedAt: z.number().nonnegative(),
});
export type McpStatus = z.infer<typeof mcpStatusSchema>;
