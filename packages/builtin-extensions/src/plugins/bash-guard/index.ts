import {
	createBashToolDefinition,
	createPowerShellToolDefinition,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS, resolveBashTimeoutSeconds } from "./timeout.ts";

/**
 * Bounds foreground shell calls without replacing Pi's execution or rendering.
 * The default settles forgotten commands; the ceiling catches common millisecond
 * inputs and directs long-running work to background processes.
 */
export default function bashGuard(pi: ExtensionAPI): void {
	guardShellTool(pi, "bash", createBashToolDefinition);
	// Pi only supports its PowerShell tool on Windows.
	if (process.platform === "win32") guardShellTool(pi, "powershell", createPowerShellToolDefinition);
}

function guardShellTool(
	pi: ExtensionAPI,
	name: "bash" | "powershell",
	createDefinition: typeof createBashToolDefinition | typeof createPowerShellToolDefinition,
): void {
	// Preserve the stock schema and renderers; describe the added timeout policy.
	const builtin = createDefinition(process.cwd());
	pi.registerTool({
		...builtin,
		name,
		description:
			`${builtin.description} timeout is in seconds and defaults to ${DEFAULT_TIMEOUT_SECONDS}s ` +
			`(max ${MAX_TIMEOUT_SECONDS}s); background anything longer instead of raising it.`,
		execute(toolCallId, params, signal, onUpdate, ctx) {
			// Pi 0.85 resolves cwd-sensitive tools from ctx.cwd. Reuse the stock
			// definition so Ling owns only the timeout policy, not Pi's cwd behavior.
			return builtin.execute(
				toolCallId,
				{ ...params, timeout: resolveBashTimeoutSeconds(params.timeout) },
				signal,
				onUpdate,
				ctx,
			);
		},
	});
}
