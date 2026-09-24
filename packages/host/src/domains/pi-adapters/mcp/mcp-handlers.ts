import { mcpProcedures } from "@ling/contracts/mcp-procedures";
import type { McpCommandRequest } from "@ling/contracts/mcp";
import type { SessionRef } from "@ling/contracts/session-ref";
import type { BuiltinFeatureStore } from "../../companions/builtin-features";
import type { HostDomain } from "../../../transport/host-domain";
import type { McpSettings } from "./mcp-settings";

/** Configuration remains editable while the bundled runtime is disabled. */
export function createMcpDomain(options: {
	settings: McpSettings;
	assertProject(cwd: string): Promise<void>;
	features: Pick<BuiltinFeatureStore, "requireEnabled">;
	runCommand(input: McpCommandRequest): Promise<void>;
	claimSession(clientId: string, ref: SessionRef): void;
}): HostDomain {
	return {
		handlers: {
			[mcpProcedures.run.channel]: async (context, input) => {
				await options.assertProject(input.ref.cwd);
				await options.features.requireEnabled("mcp");
				options.claimSession(context.clientId, input.ref);
				await options.runCommand(input);
			},
			[mcpProcedures.read.channel]: (context, input) => options.settings.read(input.cwd, context.signal),
			[mcpProcedures.write.channel]: (context, input) => options.settings.write(input, context.signal),
		},
	};
}
