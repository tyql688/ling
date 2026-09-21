import type {
	ComposerHistoryStatus,
	ExtensionAutocompleteSuggestions,
	RuntimeCommandCatalogSnapshot,
	RuntimeExtensionUiSnapshot,
} from "@ling/contracts/session";
import { sessionProcedures } from "@ling/contracts/session-procedures";
import { SESSION_COMMAND_ARGUMENT_COMPLETION_OWNER_ID } from "@ling/contracts/owner-ref";
import { createLogger } from "@ling/core/logger";
import type { SessionRuntimeCommands } from "@ling/host/domains/sessions/manager/session-runtime-commands";
import type { HostHandlers } from "../../transport/host-domain";
import type { ComposerHistory } from "./composer-history";
import type { createSessionOperationRegistry } from "./operations";

const log = createLogger("session-ipc");

export function createSessionCompanionHandlers({
	sessionOperations,
	commands,
	composerHistory,
}: {
	sessionOperations: ReturnType<typeof createSessionOperationRegistry>;
	commands: SessionRuntimeCommands;
	composerHistory: ComposerHistory;
}): HostHandlers {
	const { clearComposerHistory, flushComposerHistoryWrites, getComposerHistoryStatus, listComposerHistoryEntries } =
		composerHistory;
	const { listCommandArgumentCompletions, readSessionCommandCatalog, readSessionExtensionUiState } = commands;

	const handlers: HostHandlers = {
		[sessionProcedures.listComposerHistory.channel]: async (
			_event,
			request,
		): Promise<ReturnType<typeof listComposerHistoryEntries>> => {
			return listComposerHistoryEntries(request);
		},

		[sessionProcedures.composerHistoryStatus.channel]: async (_event): Promise<ComposerHistoryStatus> => {
			return composerHistory.inspect();
		},

		[sessionProcedures.retryComposerHistory.channel]: async (_event): Promise<ComposerHistoryStatus> => {
			try {
				await flushComposerHistoryWrites();
			} catch (error) {
				log.error("composer history retry failed:", error);
			}
			return getComposerHistoryStatus();
		},

		[sessionProcedures.clearComposerHistory.channel]: async (_event): Promise<ComposerHistoryStatus> => {
			try {
				await clearComposerHistory();
			} catch (error) {
				log.error("composer history clear failed:", error);
				throw new Error("Ling could not clear prompt history.");
			}
			return getComposerHistoryStatus();
		},

		[sessionProcedures.readCommandCatalog.channel]: async (_event, request): Promise<RuntimeCommandCatalogSnapshot> =>
			readSessionCommandCatalog(request),

		[sessionProcedures.readExtensionUiState.channel]: async (_event, request): Promise<RuntimeExtensionUiSnapshot> =>
			readSessionExtensionUiState(request),

		[sessionProcedures.listCommandArgumentCompletions.channel]: async (
			_event,
			request,
		): Promise<ExtensionAutocompleteSuggestions | null> => {
			const operation = sessionOperations.start(request, SESSION_COMMAND_ARGUMENT_COMPLETION_OWNER_ID);
			return operation.run((signal) => listCommandArgumentCompletions(request, signal));
		},
	};
	return handlers;
}
