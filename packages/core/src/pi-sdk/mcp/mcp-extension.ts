import { dirname, join } from "node:path";
import { MCP_STATUS_EVENT } from "pi-mcp-adapter/types";
import { isPiMcpSource, MCP_PACKAGE, mcpStatusSchema, type McpCommand, type McpStatus } from "@ling/contracts/mcp";
import { piPackageSource } from "@ling/contracts/pi-tool-origin";
import { readUtf8FileBounded } from "../../store/atomic-file-store";
import { createLogger } from "../../logger";
import type { PiAgentSession, PiExtensionUiContext, PiInlineExtension } from "../types";

const log = createLogger("mcp-ui");
export interface McpUi {
	open(ui: PiExtensionUiContext): void;
	status(ui: PiExtensionUiContext, value: McpStatus | null): void;
}

/** Native controls only dispatch a verified extension command, never a model prompt. */
export async function runMcpCommand(session: PiAgentSession, input: McpCommand): Promise<void> {
	if (!session.isIdle) throw new Error("Wait for the current session operation before connecting MCP.");
	const runner = session.extensionRunner;
	const name = input.action === "authenticate" ? "mcp-auth" : "mcp";
	const command = runner
		.getRegisteredCommands()
		.find((command) => command.name === name && isPiMcpSource(piPackageSource(command.sourceInfo.source)));
	if (!command) throw new Error("The MCP adapter is no longer active. Refresh its settings and try again.");
	await command.handler(
		input.action === "authenticate" ? input.name : `reconnect ${input.name}`,
		runner.createCommandContext(),
	);
}

export async function supportsPiMcp(entry: string): Promise<boolean> {
	const source = await readUtf8FileBounded(join(dirname(entry), "package.json"), 256 * 1024);
	if (source === undefined) return false;
	const value: unknown = JSON.parse(source);
	return (
		typeof value === "object" &&
		value !== null &&
		"name" in value &&
		"version" in value &&
		value.name === MCP_PACKAGE &&
		value.version === "2.37.0"
	);
}

/** Subscription belongs to one live session and is revoked before the adapter shuts down. */
export function createMcpStatusBridge(ui: McpUi): PiInlineExtension {
	return {
		name: "ling-mcp-status",
		hidden: true,
		factory(pi) {
			let release: (() => void) | undefined;
			pi.on("session_start", (_event, ctx) => {
				release?.();
				ui.status(ctx.ui, null);
				release = pi.events.on(MCP_STATUS_EVENT, (value) => {
					const parsed = mcpStatusSchema.safeParse(value);
					if (!parsed.success) {
						log.warn("Ignoring an incompatible MCP status event");
						return;
					}
					ui.status(ctx.ui, parsed.data);
				});
			});
			pi.on("session_shutdown", (_event, ctx) => {
				release?.();
				release = undefined;
				ui.status(ctx.ui, null);
			});
		},
	};
}
