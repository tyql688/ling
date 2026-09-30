import { z } from "zod";
import { argumentsOf, event, request, returns } from "./procedure";
import {
	mcpCommandSchema,
	mcpReadRequestSchema,
	mcpWriteRequestSchema,
	type McpCommandRequest,
	type McpOverview,
	type McpWriteRequest,
} from "./mcp";
import type { PiResourceReloadSummary } from "./session";
import { createSessionRequestSchemas } from "./session-requests";

const binding = createSessionRequestSchemas().sessionRuntimeBindingRequestSchema;
const commandRequest = z.discriminatedUnion("action", [
	mcpCommandSchema.options[0].extend(binding.shape),
	mcpCommandSchema.options[1].extend(binding.shape),
]);

export const mcpProcedures = {
	onChanged: event("mcp:changed", returns<null>()),
	run: request(
		"mcp:run",
		argumentsOf((args): [McpCommandRequest] => [commandRequest.parse(args[0])]),
		returns<void>(),
	),
	read: request(
		"mcp:read",
		argumentsOf((args): [{ cwd: string | null }] => [mcpReadRequestSchema.parse(args[0])]),
		returns<McpOverview>(),
	),
	write: request(
		"mcp:write",
		argumentsOf((args): [McpWriteRequest] => [mcpWriteRequestSchema.parse(args[0])]),
		returns<PiResourceReloadSummary>(),
	),
};
