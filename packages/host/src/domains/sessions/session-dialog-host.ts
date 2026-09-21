import {
	type ApprovalRequest,
	type DialogDismissEvent,
	EXTENSION_UI_INPUT_MAX_CHARS,
	EXTENSION_UI_TEXT_MAX_CHARS,
	type ExtensionUiRequest,
	type SessionRef,
} from "@ling/contracts/session";
import { sessionProcedures } from "@ling/contracts/session-procedures";
import { sessionKey } from "@ling/contracts/session-ref";
import type { ExtensionUiBridge } from "@ling/core/pi-protocol/extension-ui";
import type { SessionRegistry } from "@ling/host/domains/sessions/manager/session-registry";
import type { HostClientState } from "@ling/host/transport/client-state";
import type { HostEventPublisher } from "@ling/host/transport/event-bus";
import { createPairedDialog } from "../../transport/paired-dialog";
import type { HostShellActivity } from "../../transport/shell-activity";

type ExtensionUiPayload = Omit<ExtensionUiRequest, "requestId">;
type ApprovalPayload = Omit<ApprovalRequest, "requestId">;
type PromptOptions = { signal?: AbortSignal; timeout?: number };
type ExtensionPrompt = Parameters<Parameters<SessionRegistry["setExtensionUiRequester"]>[1]>[1];
type CoreApprovalRequest = Parameters<Parameters<SessionRegistry["setApprovalRequester"]>[1]>[0];

/**
 * Node `setTimeout` platform cap for a single delay (~2^31-1 ms). Larger values get
 * clamped to 1ms, which would reject long Pi dialog timeouts instantly; over-long
 * timeouts must be chained in slices of this size.
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;
/** Unanswered extension prompts are intentionally long-lived, but never unbounded. */
const EXTENSION_UI_DIALOG_CAPACITY = 64;
/** Approval cards likewise remain until response/session teardown, under a hard cap. */
const APPROVAL_DIALOG_CAPACITY = 64;
const EXTENSION_DIALOG_OPTION_MAX_ITEMS = 256;

export interface SessionDialogHost {
	bind(ref: SessionRef): () => void;
	pendingApprovals(): ApprovalRequest[];
	pendingExtensionUi(): ExtensionUiRequest[];
	assertApprovalOwner(clientId: string, requestId: string): void;
	assertExtensionUiOwner(clientId: string, requestId: string): void;
	respondApproval(requestId: string, approved: boolean): void;
	respondExtensionUi(requestId: string, value: string | undefined): void;
	dispose(): void;
}

function positiveTimeout(options: PromptOptions | undefined): number | null {
	const timeout = options?.timeout;
	return typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0 ? timeout : null;
}

function timeoutExpiresAt(options: PromptOptions | undefined): number | null {
	const timeout = positiveTimeout(options);
	if (timeout === null) return null;
	const expiresAt = Date.now() + timeout;
	return Number.isFinite(expiresAt) ? expiresAt : null;
}

function assertBoundedDialogText(value: unknown, limit: number, label: string): asserts value is string {
	if (typeof value !== "string" || value.length > limit) throw new Error(`${label} is too large`);
}

function assertExtensionPrompt(prompt: ExtensionPrompt): void {
	assertBoundedDialogText(prompt.title, EXTENSION_UI_INPUT_MAX_CHARS, "Extension prompt title");
	if (prompt.kind === "select") {
		if (!Array.isArray(prompt.options) || prompt.options.length > EXTENSION_DIALOG_OPTION_MAX_ITEMS) {
			throw new Error("Extension prompt option count is too large");
		}
		let totalChars = 0;
		for (const option of prompt.options) {
			assertBoundedDialogText(option, EXTENSION_UI_INPUT_MAX_CHARS, "Extension prompt option");
			totalChars += option.length;
			if (totalChars > EXTENSION_UI_TEXT_MAX_CHARS) throw new Error("Extension prompt options are too large");
		}
		return;
	}
	if (prompt.kind === "input") {
		if (prompt.placeholder !== null) {
			assertBoundedDialogText(prompt.placeholder, EXTENSION_UI_INPUT_MAX_CHARS, "Extension input placeholder");
		}
		return;
	}
	assertBoundedDialogText(prompt.initialValue, EXTENSION_UI_TEXT_MAX_CHARS, "Extension editor value");
}

function assertApprovalRequest(request: CoreApprovalRequest): void {
	assertBoundedDialogText(request.title, EXTENSION_UI_INPUT_MAX_CHARS, "Approval title");
	assertBoundedDialogText(request.message, EXTENSION_UI_TEXT_MAX_CHARS, "Approval message");
}

function scheduleTimeout(timeout: number, callback: () => void): () => void {
	const expiresAt = Date.now() + timeout;
	if (!Number.isFinite(expiresAt)) return () => undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const scheduleNext = (): void => {
		const remaining = expiresAt - Date.now();
		if (remaining <= 0) {
			callback();
			return;
		}
		timer = setTimeout(scheduleNext, Math.min(remaining, MAX_TIMER_DELAY_MS));
	};
	scheduleNext();
	return () => {
		if (timer !== undefined) clearTimeout(timer);
	};
}

function requestDialogWithLifecycle<TPayload, TRequest extends { requestId: string }, TResponse>(
	dialog: {
		requestWithHandle(payload: TPayload): {
			request: TRequest;
			response: Promise<TResponse>;
			respond(response: TResponse): boolean;
		};
	},
	payload: TPayload,
	options: PromptOptions | undefined,
	cancelResponse: TResponse,
	sendDismiss: (event: DialogDismissEvent) => void,
	onPending: () => void,
): Promise<TResponse> {
	if (options?.signal?.aborted) return Promise.resolve(cancelResponse);

	const handle = dialog.requestWithHandle(payload);
	const settleCancelled = (): void => {
		if (handle.respond(cancelResponse)) sendDismiss({ requestId: handle.request.requestId });
	};
	const timeout = positiveTimeout(options);
	const cancelTimeout = timeout === null ? undefined : scheduleTimeout(timeout, settleCancelled);
	options?.signal?.addEventListener("abort", settleCancelled, { once: true });

	const response = handle.response.finally(() => {
		cancelTimeout?.();
		options?.signal?.removeEventListener("abort", settleCancelled);
	});
	if (options?.signal?.aborted) {
		settleCancelled();
	} else {
		try {
			onPending();
		} catch (error) {
			try {
				settleCancelled();
			} catch (cleanupError) {
				throw new AggregateError([error, cleanupError], "Failed to notify and dismiss the pending dialog");
			}
			throw error;
		}
	}
	return response;
}

export function createSessionDialogHost(
	events: HostEventPublisher,
	clients: HostClientState,
	{
		registry,
		extensionUi,
		shellActivity,
	}: {
		registry: Pick<SessionRegistry, "setApprovalRequester" | "setExtensionUiRequester">;
		extensionUi: ExtensionUiBridge;
		shellActivity: Pick<HostShellActivity, "notify">;
	},
): SessionDialogHost {
	const {
		clearExtensionUiState,
		getApprovalRequester,
		getExtensionUiRequester,
		unregisterApprovalRequester,
		unregisterExtensionUiRequester,
	} = extensionUi;
	const { setApprovalRequester, setExtensionUiRequester } = registry;

	const publish = (ref: SessionRef, channel: string, payload: unknown): void => {
		const owner = clients.ownerOfSession(ref);
		if (owner === null) events.broadcast(channel, payload);
		else events.send(owner, channel, payload);
	};
	const extensionUiDialog = createPairedDialog<ExtensionUiPayload, ExtensionUiRequest, string | undefined>({
		buildRequest: (requestId, payload) => ({ requestId, ...payload }),
		send: (request) => publish(request.ref, sessionProcedures.onExtensionUiRequest.channel, request),
		maxPending: {
			limit: EXTENSION_UI_DIALOG_CAPACITY,
			resource: "extensionUiDialog",
			message: "The extension input backlog is full. Resolve an existing prompt, then retry.",
		},
	});
	const approvalDialog = createPairedDialog<ApprovalPayload, ApprovalRequest, boolean>({
		buildRequest: (requestId, payload) => ({ requestId, ...payload }),
		send: (request) => publish(request.ref, sessionProcedures.onApprovalRequest.channel, request),
		maxPending: {
			limit: APPROVAL_DIALOG_CAPACITY,
			resource: "approvalDialog",
			message: "The approval backlog is full. Resolve an existing approval, then retry.",
		},
	});

	return {
		bind(ref) {
			const extensionUiRequester: Parameters<SessionRegistry["setExtensionUiRequester"]>[1] = (requestRef, prompt) => {
				assertExtensionPrompt(prompt);
				const promptOptions = "promptOptions" in prompt ? prompt.promptOptions : undefined;
				return requestDialogWithLifecycle(
					extensionUiDialog,
					{
						ref: requestRef,
						kind: prompt.kind,
						title: prompt.title,
						options: prompt.kind === "select" ? prompt.options : [],
						placeholder: prompt.kind === "input" ? prompt.placeholder : null,
						initialValue: prompt.kind === "editor" ? prompt.initialValue : null,
						expiresAt: timeoutExpiresAt(promptOptions),
					},
					promptOptions,
					undefined,
					(event) => publish(requestRef, sessionProcedures.onExtensionUiDismiss.channel, event),
					() => shellActivity.notify(requestRef, "attentionNeeded", "Ling — input needed", prompt.title),
				);
			};

			const approvalRequester: Parameters<SessionRegistry["setApprovalRequester"]>[1] = (request) => {
				assertApprovalRequest(request);
				return requestDialogWithLifecycle(
					approvalDialog,
					{
						ref: request.ref,
						title: request.title,
						message: request.message,
						expiresAt: timeoutExpiresAt(request.options),
					},
					request.options,
					false,
					(event) => publish(request.ref, sessionProcedures.onApprovalDismiss.channel, event),
					() => shellActivity.notify(request.ref, "attentionNeeded", "Ling — approval needed", request.title),
				);
			};
			setExtensionUiRequester(ref, extensionUiRequester);
			setApprovalRequester(ref, approvalRequester);
			let released = false;
			return () => {
				if (released) return;
				released = true;
				const ownsExtensionUi = getExtensionUiRequester(ref) === extensionUiRequester;
				const ownsApproval = getApprovalRequester(ref) === approvalRequester;
				unregisterExtensionUiRequester(ref, extensionUiRequester);
				unregisterApprovalRequester(ref, approvalRequester);
				const key = sessionKey(ref);
				if (ownsExtensionUi) {
					extensionUiDialog.clearWhere((request) => sessionKey(request.ref) === key, undefined);
					clearExtensionUiState(ref);
				}
				if (ownsApproval) {
					approvalDialog.clearWhere((request) => sessionKey(request.ref) === key, false);
				}
			};
		},
		pendingApprovals: () => approvalDialog.pending().map((request) => structuredClone(request)),
		pendingExtensionUi: () => extensionUiDialog.pending().map((request) => structuredClone(request)),
		assertApprovalOwner(clientId, requestId) {
			const request = approvalDialog.pending().find((candidate) => candidate.requestId === requestId);
			if (!request) throw new Error("Unknown approval request");
			clients.assertCanRespond(clientId, request.ref);
		},
		assertExtensionUiOwner(clientId, requestId) {
			const request = extensionUiDialog.pending().find((candidate) => candidate.requestId === requestId);
			if (!request) throw new Error("Unknown extension UI request");
			clients.assertCanRespond(clientId, request.ref);
		},
		respondApproval: (requestId, approved) => approvalDialog.respondOrThrow(requestId, approved),
		respondExtensionUi: (requestId, value) => extensionUiDialog.respondOrThrow(requestId, value),
		dispose() {
			extensionUiDialog.clearWhere(() => true, undefined);
			approvalDialog.clearWhere(() => true, false);
		},
	};
}
