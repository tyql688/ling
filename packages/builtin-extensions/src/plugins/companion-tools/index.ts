import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { companionToolParameters, companionTools, type CompanionToolName } from "@ling/contracts/companion-tools";
import type { CompanionToolCall, CompanionToolResult } from "@ling/contracts/companions";
import type { BuiltinFeatureFlags } from "@ling/contracts/builtin-features";
import { Type } from "typebox";

export type CompanionToolHost = (call: CompanionToolCall, signal?: AbortSignal) => Promise<CompanionToolResult>;

/** Registers the Host-implemented agent tools; the Host validates each call's input and runs it. */
export function createCompanionTools(
	host: CompanionToolHost,
	features: BuiltinFeatureFlags,
): (pi: ExtensionAPI) => void {
	return (pi) => {
		for (const name of Object.keys(companionTools) as CompanionToolName[]) {
			if (!features[companionTools[name].feature]) continue;
			pi.registerTool({
				name,
				label: name,
				description: companionTools[name].description,
				parameters: Type.Unsafe(companionToolParameters(name)),
				async execute(_toolCallId, params, signal, _onUpdate, ctx) {
					return host(
						{
							name,
							ref: { cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId() },
							input: params as CompanionToolCall["input"],
						},
						signal,
					);
				},
			});
		}
	};
}
