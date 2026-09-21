import { companionTools, type CompanionToolName } from "@ling/contracts/companion-tools";
import type { CompanionToolCall, CompanionToolResult } from "@ling/contracts/companions";
import type { SessionRef } from "@ling/contracts/session-ref";
import { z } from "zod";

/** Each handler receives its tool's input parsed with the full schema. */
export type CompanionToolHandlers = {
	[Name in CompanionToolName]: (
		ref: SessionRef,
		input: z.output<(typeof companionTools)[Name]["input"]>,
		signal: AbortSignal,
	) => Promise<CompanionToolResult>;
};

export function toolResult(value: unknown, text = JSON.stringify(value, null, 2)): CompanionToolResult {
	return { content: [{ type: "text", text }], details: z.json().parse(value) };
}

/** Routes an agent tool call to the feature that owns the tool. */
export function createCompanionToolDispatch(handlers: CompanionToolHandlers) {
	return (call: CompanionToolCall, signal: AbortSignal): Promise<CompanionToolResult> => {
		if (!Object.hasOwn(companionTools, call.name)) throw new Error(`Unknown companion tool: ${call.name}`);
		const name = call.name as CompanionToolName;
		const handler = handlers[name] as (
			ref: SessionRef,
			input: unknown,
			signal: AbortSignal,
		) => Promise<CompanionToolResult>;
		return handler(call.ref, companionTools[name].input.parse(call.input), signal);
	};
}
