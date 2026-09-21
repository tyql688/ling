import type { ExtensionAutocompleteSuggestions } from "@ling/contracts/session";
import { EXTENSION_AUTOCOMPLETE_MAX_ITEMS } from "@ling/contracts/session";
import { throwIfOperationAborted, waitForOperation } from "../../ling-error";
import { assertPiExtensionAutocompleteSuggestions } from "../extensions/extension-ui-autocomplete";
import type { PiAgentSession } from "../types";

export async function completePiRuntimeCommandArgument(
	session: PiAgentSession,
	commandName: string,
	argumentPrefix: string,
	signal?: AbortSignal,
): Promise<ExtensionAutocompleteSuggestions | null> {
	throwIfOperationAborted(signal);
	const command = session.extensionRunner
		.getRegisteredCommands()
		.find((candidate) => candidate.invocationName === commandName);
	if (!command?.getArgumentCompletions) return null;

	const items = await waitForOperation(command.getArgumentCompletions(argumentPrefix), signal);
	if (!Array.isArray(items) || items.length === 0) return null;
	if (items.length > EXTENSION_AUTOCOMPLETE_MAX_ITEMS) {
		throw new Error(`Extension command returned too many completions (maximum ${EXTENSION_AUTOCOMPLETE_MAX_ITEMS})`);
	}
	assertPiExtensionAutocompleteSuggestions({
		items,
		prefix: argumentPrefix,
	});
	throwIfOperationAborted(signal);
	return { items, prefix: argumentPrefix };
}
