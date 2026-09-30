import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MCP_BUILTIN_SOURCE, MCP_STATUS_MAX_CHARS, type McpCommand, type McpStatus } from "@ling/contracts/mcp";
import type { PiAgentSession, PiExtensionUiContext, PiLoadExtensionsResult } from "../types";

export interface McpUi {
	open(ui: PiExtensionUiContext): void;
	status(ui: PiExtensionUiContext, value: McpStatus | null): void;
}

/** Dispatches the verified official command in the current idle runtime. */
export async function runMcpCommand(session: PiAgentSession, input: McpCommand): Promise<void> {
	if (!session.isIdle) throw new Error("Wait for the current session operation before managing MCP.");
	const runner = session.extensionRunner;
	const command = runner
		.getRegisteredCommands()
		.find((command) => command.name === "mcp" && command.sourceInfo.path === MCP_BUILTIN_SOURCE);
	if (!command)
		throw new Error(
			"Official Pi MCP is unavailable. Check its feature switch and Pi extension settings; an installed /mcp extension takes precedence.",
		);
	const args =
		input.action === "status"
			? "status"
			: `${input.action === "authenticate" ? "login" : input.action === "connect" ? "reconnect" : "logout"} ${input.name}`;
	await command.handler(args, runner.createCommandContext());
}

/** Keeps OAuth and connections in Pi while presenting its public status output in Ling. */
export function adaptMcpExtension(extension: PiLoadExtensionsResult["extensions"][number], ui: McpUi) {
	const command = extension.commands.get("mcp");
	if (!command) throw new Error("Official Pi MCP did not register its management command.");
	extension.commands.set("mcp", {
		...command,
		handler: async (args, ctx) => {
			const input = args.trim();
			if (input !== "" && input !== "status") await command.handler(args, ctx);
			await command.handler("", {
				...ctx,
				mode: "rpc",
				ui: {
					...ctx.ui,
					notify(message, type) {
						if (type === "error" || type === "warning") ctx.ui.notify(message, type);
						// Keep a bounded complete prefix and disclose clipping of unusually large status reports.
						const text =
							message.length > MCP_STATUS_MAX_CHARS
								? `${message.slice(0, MCP_STATUS_MAX_CHARS - 32)}\n[Status output truncated]`
								: message;
						ui.status(ctx.ui, { version: 2, text, updatedAt: Date.now() });
					},
				},
			});
			if (input === "") ui.open(ctx.ui);
		},
	});
	extension.handlers.set("session_start", [
		...(extension.handlers.get("session_start") ?? []),
		async (_event, ctx) => ui.status((ctx as ExtensionContext).ui, null),
	]);
	extension.handlers.set("session_shutdown", [
		...(extension.handlers.get("session_shutdown") ?? []),
		async (_event, ctx) => ui.status((ctx as ExtensionContext).ui, null),
	]);
}
