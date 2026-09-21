import type {
	ApplyExtensionAutocompleteResult,
	ApprovalRequest,
	ExtensionAutocompleteSuggestions,
	ExtensionTerminalInputResult,
	ExtensionUiRequest,
} from "@ling/contracts/session";
import { sessionProcedures } from "@ling/contracts/session-procedures";
import { SESSION_AUTOCOMPLETE_OWNER_ID } from "@ling/contracts/owner-ref";
import type { SessionRuntimeCommands } from "@ling/host/domains/sessions/manager/session-runtime-commands";
import type { SessionDialogHost } from "@ling/host/domains/sessions/session-dialog-host";
import type { HostHandlers } from "../../transport/host-domain";
import type { createSessionOperationRegistry } from "./operations";

export function createSessionDialogHandlers({
	dialogs,
	sessionOperations,
	onInteractionSettled,
	commands,
}: {
	dialogs: SessionDialogHost;
	sessionOperations: ReturnType<typeof createSessionOperationRegistry>;
	onInteractionSettled(): void;
	commands: SessionRuntimeCommands;
}): HostHandlers {
	const {
		applyExtensionAutocomplete,
		dispatchExtensionTerminalInput,
		getExtensionAutocompleteSuggestions,
		sendExtensionUiInput,
		setExtensionUiEditorText,
		updateExtensionUiViewport,
	} = commands;

	const handlers: HostHandlers = {
		[sessionProcedures.pendingExtensionUiRequests.channel]: async (): Promise<ExtensionUiRequest[]> => {
			return dialogs.pendingExtensionUi();
		},

		[sessionProcedures.respondToExtensionUi.channel]: async (context, requestId, value): Promise<void> => {
			const response = { requestId, value };
			dialogs.assertExtensionUiOwner(context.clientId, response.requestId);
			dialogs.respondExtensionUi(response.requestId, response.value === null ? undefined : response.value);
			onInteractionSettled();
		},

		[sessionProcedures.sendExtensionUiInput.channel]: async (
			_event,
			request,
		): Promise<ExtensionTerminalInputResult> => {
			return sendExtensionUiInput(request.ref, request.data);
		},

		[sessionProcedures.dispatchExtensionTerminalInput.channel]: async (
			_event,
			request,
		): Promise<ExtensionTerminalInputResult> => {
			return dispatchExtensionTerminalInput(request.ref, request.data);
		},

		[sessionProcedures.updateExtensionUiViewport.channel]: async (_event, request): Promise<void> => {
			await updateExtensionUiViewport(
				request.ref,
				request.columns,
				request.rows,
				request.markdownColumns,
				request.dockColumns,
			);
		},

		[sessionProcedures.setExtensionUiEditorText.channel]: async (_event, request): Promise<void> => {
			await setExtensionUiEditorText(request);
		},

		[sessionProcedures.getExtensionAutocomplete.channel]: async (
			_event,
			request,
		): Promise<ExtensionAutocompleteSuggestions | null> => {
			const operation = sessionOperations.start(request, SESSION_AUTOCOMPLETE_OWNER_ID);
			return operation.run((signal) => getExtensionAutocompleteSuggestions(request, signal));
		},

		[sessionProcedures.applyExtensionAutocomplete.channel]: async (
			_event,
			request,
		): Promise<ApplyExtensionAutocompleteResult> => {
			return applyExtensionAutocomplete(request);
		},

		[sessionProcedures.pendingApprovalRequests.channel]: async (): Promise<ApprovalRequest[]> => {
			return dialogs.pendingApprovals();
		},

		[sessionProcedures.respondToApproval.channel]: async (context, requestId, approved): Promise<void> => {
			const response = { requestId, approved };
			dialogs.assertApprovalOwner(context.clientId, response.requestId);
			dialogs.respondApproval(response.requestId, response.approved);
			onInteractionSettled();
		},
	};
	return handlers;
}
