import type { SessionRef } from "@ling/contracts/session";
import { sessionKey } from "@ling/contracts/session-ref";
import type { ApprovalRequester, ExtensionUiBridge, ExtensionUiRequester } from "@ling/core/pi-protocol/extension-ui";
import type { PiWorkerCallMain } from "../../pi-protocol/callback-methods";

export interface PiWorkerDialogContext {
	runtimeId: string;
	creationRequestId: string;
	creationSignal: AbortSignal;
	refs: Map<string, SessionRef>;
	approvalRequester: ApprovalRequester;
	extensionUiRequester: ExtensionUiRequester;
}

export interface PiWorkerDialogBridge {
	create(runtimeId: string, creationRequestId: string, creationSignal: AbortSignal): PiWorkerDialogContext;
	beforeBind(context: PiWorkerDialogContext, ref: SessionRef): Promise<undefined>;
	bind(context: PiWorkerDialogContext, ref: SessionRef): void;
	release(context: PiWorkerDialogContext, ref: SessionRef): void;
	releaseAll(context: PiWorkerDialogContext): void;
	runtimeIdFor(ref: SessionRef): string | null;
}

/** Keep the transport alive long enough for Main's dialog timer to settle first. */
const DIALOG_TRANSPORT_GRACE_MS = 5_000;

function requestDeadlineTimeout(options: { timeout?: number } | undefined): number | undefined {
	const timeout = options?.timeout;
	if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) return undefined;
	return Math.min(timeout + DIALOG_TRANSPORT_GRACE_MS, Number.MAX_SAFE_INTEGER - Date.now());
}

export function createPiWorkerDialogBridge(
	callMain: PiWorkerCallMain,
	bridge: ExtensionUiBridge,
): PiWorkerDialogBridge {
	const {
		clearExtensionUiState,
		registerApprovalRequester,
		registerExtensionUiRequester,
		unregisterApprovalRequester,
		unregisterExtensionUiRequester,
	} = bridge;

	const owners = new Map<string, PiWorkerDialogContext>();

	const create = (runtimeId: string, creationRequestId: string, creationSignal: AbortSignal): PiWorkerDialogContext => {
		const approvalRequester: ApprovalRequester = async (request) => {
			const timeoutMs = requestDeadlineTimeout(request.options);
			return callMain(
				"extension.confirm",
				{
					ref: request.ref,
					title: request.title,
					message: request.message,
					...(request.options?.timeout === undefined ? {} : { timeout: request.options.timeout }),
				},
				{
					...(timeoutMs === undefined ? {} : { timeoutMs }),
					...(request.options?.signal === undefined ? {} : { signal: request.options.signal }),
				},
			);
		};
		const extensionUiRequester: ExtensionUiRequester = async (ref, prompt) => {
			const promptOptions = "promptOptions" in prompt ? prompt.promptOptions : undefined;
			const timeoutMs = requestDeadlineTimeout(promptOptions);
			const result = await callMain(
				"extension.prompt",
				{
					ref,
					prompt: {
						title: prompt.title,
						...(prompt.kind === "select"
							? { kind: prompt.kind, options: prompt.options }
							: prompt.kind === "input"
								? { kind: prompt.kind, placeholder: prompt.placeholder }
								: { kind: prompt.kind, initialValue: prompt.initialValue }),
						...(promptOptions?.timeout === undefined ? {} : { timeout: promptOptions.timeout }),
					},
				},
				{
					...(timeoutMs === undefined ? {} : { timeoutMs }),
					...(promptOptions?.signal === undefined ? {} : { signal: promptOptions.signal }),
				},
			);
			return result ?? undefined;
		};
		return {
			runtimeId,
			creationRequestId,
			creationSignal,
			refs: new Map(),
			approvalRequester,
			extensionUiRequester,
		};
	};

	const bind = (context: PiWorkerDialogContext, ref: SessionRef): void => {
		const key = sessionKey(ref);
		if (context.refs.has(key)) return;
		const owner = owners.get(key);
		if (owner && owner !== context) {
			throw new Error(`Pi worker dialog identity is already owned: ${ref.sessionId}`);
		}
		registerApprovalRequester(ref, context.approvalRequester);
		registerExtensionUiRequester(ref, context.extensionUiRequester);
		context.refs.set(key, { ...ref });
		owners.set(key, context);
	};

	const release = (context: PiWorkerDialogContext, ref: SessionRef): void => {
		const key = sessionKey(ref);
		if (!context.refs.delete(key)) return;
		if (owners.get(key) === context) owners.delete(key);
		unregisterApprovalRequester(ref, context.approvalRequester);
		unregisterExtensionUiRequester(ref, context.extensionUiRequester);
		clearExtensionUiState(ref);
	};

	return {
		create,
		async beforeBind(context, ref) {
			await callMain(
				"runtime.beforeBind",
				{
					creationRequestId: context.creationRequestId,
					runtimeId: context.runtimeId,
					ref,
				},
				{ signal: context.creationSignal },
			);
			bind(context, ref);
			return undefined;
		},
		bind,
		release,
		releaseAll(context) {
			for (const ref of [...context.refs.values()]) release(context, ref);
		},
		runtimeIdFor(ref) {
			return owners.get(sessionKey(ref))?.runtimeId ?? null;
		},
	};
}
