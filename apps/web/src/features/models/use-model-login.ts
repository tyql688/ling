import { useDomainApi } from "@renderer/lib/host-api-context";

import type { ModelLoginEvent, ProviderSummary } from "@ling/contracts/model";

import { errorMessage } from "@ling/contracts/ling-error";

import { useCopyFeedback } from "@renderer/hooks/use-copy-feedback";

import { useImeGuard } from "@renderer/hooks/use-ime-guard";

import { formatRequestError } from "@renderer/lib/errors";

import { createRequestFence, type RequestFence } from "@renderer/lib/request-fence";

import { useEffect, useId, useRef, useState } from "react";

import { useTranslation } from "react-i18next";

interface LoginFlowState {
	progress: string | null;
	authUrl: string | null;
	instructions: string | null;
	deviceCode: { userCode: string; verificationUri: string } | null;
	infos: { message: string; links: { url: string; label: string | null }[] }[];
	prompt: { requestId: string; message: string; placeholder: string | null; secret: boolean } | null;
	manualCode: { requestId: string; message: string; placeholder: string | null } | null;
	select: {
		requestId: string;
		message: string;
		options: { id: string; label: string; description: string | null }[];
	} | null;
	done: Extract<ModelLoginEvent, { type: "done" }> | null;
}

/** Initial state of the OAuth/device-code login wizard: every step UI slot is empty. */
const INITIAL_LOGIN_FLOW: LoginFlowState = {
	progress: null,
	authUrl: null,
	instructions: null,
	deviceCode: null,
	infos: [],
	prompt: null,
	manualCode: null,
	select: null,
	done: null,
};

/** A provider may emit repeated informational progress events during one OAuth flow. */
const MAX_LOGIN_INFO_MESSAGES = 64;

function removeAnsweredLoginRequest(previous: LoginFlowState, requestId: string): LoginFlowState {
	return {
		...previous,
		prompt: previous.prompt?.requestId === requestId ? null : previous.prompt,
		select: previous.select?.requestId === requestId ? null : previous.select,
		manualCode: previous.manualCode?.requestId === requestId ? null : previous.manualCode,
	};
}

/** React StrictMode immediately cancels this timer when it replays the effect. A real
 * unmount has no matching setup, so the abandoned main-process login is cancelled. */
function deferLoginCancellation(cancel: () => void): () => void {
	const timer = globalThis.setTimeout(cancel, 0);
	return () => globalThis.clearTimeout(timer);
}

function reduceLoginFlow(previous: LoginFlowState, event: ModelLoginEvent): LoginFlowState {
	switch (event.type) {
		case "auth-url":
			return { ...previous, authUrl: event.url, instructions: event.instructions };
		case "device-code":
			return { ...previous, deviceCode: { userCode: event.userCode, verificationUri: event.verificationUri } };
		case "info":
			return {
				...previous,
				infos: [...previous.infos, { message: event.message, links: event.links }].slice(-MAX_LOGIN_INFO_MESSAGES),
			};
		case "prompt":
			return {
				...previous,
				prompt: {
					requestId: event.requestId,
					message: event.message,
					placeholder: event.placeholder,
					secret: event.secret,
				},
			};
		case "manual-code":
			return {
				...previous,
				manualCode: {
					requestId: event.requestId,
					message: event.message,
					placeholder: event.placeholder,
				},
			};
		case "select":
			return { ...previous, select: { requestId: event.requestId, message: event.message, options: event.options } };
		case "request-cancelled":
			return removeAnsweredLoginRequest(previous, event.requestId);
		case "progress":
			return { ...previous, progress: event.message };
		case "done":
			return {
				...previous,
				done: event,
				prompt: null,
				manualCode: null,
				select: null,
			};
	}
}
export type ModelsLoginDialogProps = {
	provider: ProviderSummary;
	method: "api_key" | "oauth";
	onClose: () => void;
};

/** Owns the form's asynchronous work, recovery state and submission intent. */
export function useModelLogin({ provider, method, onClose }: ModelsLoginDialogProps) {
	const hostModelsApi = useDomainApi("models");
	const hostAppApi = useDomainApi("app");

	const { t } = useTranslation();
	const [flow, setFlow] = useState<LoginFlowState>(INITIAL_LOGIN_FLOW);
	const [inputDraft, setInputDraft] = useState("");
	const { copiedKey: copiedUrl, markCopied } = useCopyFeedback<string>();
	const [responseError, setResponseError] = useState<string | null>(null);
	const [respondingRequestId, setRespondingRequestId] = useState<string | null>(null);
	const [revealedSecret, setRevealedSecret] = useState<string | null>(null);
	const [showSecret, setShowSecret] = useState(false);
	const [revealingSecret, setRevealingSecret] = useState(false);
	const activeInputLabelId = useId();
	const ime = useImeGuard();
	const { resetComposition } = ime;
	// StrictMode re-runs effects on a simulated remount (refs survive it) — without this
	// guard the second run would call loginStart again and trip "already in progress".
	// Cleanup cancellation is deferred one task so StrictMode's immediate effect replay can revoke it.
	const started = useRef(false);
	const flowId = useRef(crypto.randomUUID());
	const flowFinished = useRef(false);
	const cancelRequested = useRef(false);
	const respondingRequest = useRef<string | null>(null);
	const clearDeferredCancellation = useRef<(() => void) | null>(null);
	const secretRevealFenceRef = useRef<RequestFence<string> | null>(null);
	if (secretRevealFenceRef.current === null) secretRevealFenceRef.current = createRequestFence<string>();
	const secretRevealFence = secretRevealFenceRef.current;
	const activeInput = flow.prompt
		? {
				requestId: flow.prompt.requestId,
				message: flow.prompt.message,
				placeholder: flow.prompt.placeholder,
				secret: flow.prompt.secret,
			}
		: flow.manualCode !== null
			? {
					requestId: flow.manualCode.requestId,
					message: flow.manualCode.message,
					placeholder: flow.manualCode.placeholder,
					secret: false,
				}
			: null;
	const activeSecretRequestId = activeInput?.secret ? activeInput.requestId : null;
	const activeSecretRequestRef = useRef<string | null>(activeSecretRequestId);
	if (activeSecretRequestRef.current !== activeSecretRequestId) {
		activeSecretRequestRef.current = activeSecretRequestId;
		secretRevealFence.invalidate();
	}

	useEffect(() => {
		clearDeferredCancellation.current?.();
		clearDeferredCancellation.current = null;
		const unsubscribe = hostModelsApi.onLoginEvent((envelope) => {
			if (envelope.flowId !== flowId.current) return;
			const event = envelope.event;
			if (event.type === "done") flowFinished.current = true;
			if (event.type === "request-cancelled") setInputDraft("");
			if (
				event.type === "prompt" ||
				event.type === "manual-code" ||
				event.type === "request-cancelled" ||
				event.type === "done"
			) {
				resetComposition();
				setRevealedSecret(null);
				setShowSecret(false);
				setRevealingSecret(false);
			}
			setFlow((previous) => reduceLoginFlow(previous, event));
		});
		if (!started.current) {
			started.current = true;
			void hostModelsApi
				.loginStart({ flowId: flowId.current, provider: provider.id, method, cwd: provider.projectCwd })
				.catch((cause: unknown) => {
					// Pre-flight rejection (another login already running) — no "done" event will come.
					const message = errorMessage(cause);
					setFlow((previous) => ({
						...previous,
						done: {
							type: "done",
							ok: false,
							error: message,
							credentialSynchronization: null,
						},
					}));
				});
		}
		return () => {
			secretRevealFence.invalidate();
			unsubscribe();
			if (flowFinished.current || cancelRequested.current) return;
			clearDeferredCancellation.current = deferLoginCancellation(() => {
				clearDeferredCancellation.current = null;
				// eslint-disable-next-line react-hooks/exhaustive-deps -- the cleanup deliberately reads the ref as it stands at teardown, not the value captured at setup
				void hostModelsApi.loginCancel({ flowId: flowId.current }).catch((cause: unknown) => {
					console.error("Failed to cancel abandoned model login", cause);
				});
			});
		};
	}, [hostModelsApi, method, provider.id, provider.projectCwd, secretRevealFence, resetComposition]);

	const respond = async (requestId: string, value: string | null) => {
		if (respondingRequest.current !== null) return;
		respondingRequest.current = requestId;
		setRespondingRequestId(requestId);
		const submittedDraft = inputDraft;
		try {
			await hostModelsApi.loginRespond({ flowId: flowId.current, requestId, value });
			resetComposition();
			setInputDraft((current) => (current === submittedDraft ? "" : current));
			setRevealedSecret(null);
			setShowSecret(false);
			// A request is spent only after main accepted the response. IPC validation or
			// transport failures keep the sole retry surface and its draft intact.
			setFlow((previous) => removeAnsweredLoginRequest(previous, requestId));
			setResponseError(null);
		} catch (cause) {
			setResponseError(formatRequestError(cause, t));
		} finally {
			if (respondingRequest.current === requestId) respondingRequest.current = null;
			setRespondingRequestId((current) => (current === requestId ? null : current));
		}
	};

	const handleClose = () => {
		resetComposition();
		secretRevealFence.invalidate();
		cancelRequested.current = true;
		clearDeferredCancellation.current?.();
		clearDeferredCancellation.current = null;
		// Only a real `done` event proves the core flow settled. A pre-flight
		// "already in progress" error still gives this dialog a way to cancel an
		// orphan left by an older renderer.
		if (!flowFinished.current) {
			void hostModelsApi.loginCancel({ flowId: flowId.current }).catch((cause: unknown) => {
				console.error("Failed to cancel model login", cause);
			});
		}
		onClose();
	};

	const loginMethod = method === "oauth" ? provider.authMethods.oauth?.name : provider.authMethods.apiKey?.name;
	const activeInputValue = revealedSecret ?? inputDraft;
	const canSubmit = activeInput === null || !activeInput.secret || activeInputValue.trim().length > 0;

	const toggleSecretVisibility = async () => {
		if (!activeInput?.secret) return;
		if (showSecret) {
			secretRevealFence.invalidate();
			setShowSecret(false);
			setRevealedSecret(null);
			return;
		}
		if (inputDraft !== "") {
			setShowSecret(true);
			return;
		}
		const request = secretRevealFence.begin(activeInput.requestId);
		setRevealingSecret(true);
		try {
			const key = await hostModelsApi.getApiKey({ provider: provider.id, cwd: provider.projectCwd });
			if (!secretRevealFence.isCurrent(request, activeSecretRequestRef.current)) return;
			if (key === null) return;
			setRevealedSecret(key);
			setShowSecret(true);
			setResponseError(null);
		} catch (cause) {
			if (!secretRevealFence.isCurrent(request, activeSecretRequestRef.current)) return;
			setResponseError(formatRequestError(cause, t));
		} finally {
			if (secretRevealFence.isCurrent(request, activeSecretRequestRef.current)) setRevealingSecret(false);
		}
	};

	const openExternal = (url: string) => {
		void hostAppApi.openExternal(url).catch((cause: unknown) => {
			setResponseError(formatRequestError(cause, t));
		});
	};

	const copyUrl = async (url: string) => {
		try {
			await navigator.clipboard.writeText(url);
			markCopied(url);
			setResponseError(null);
		} catch (cause) {
			setResponseError(formatRequestError(cause, t));
		}
	};
	return {
		handleClose,
		provider,
		t,
		loginMethod,
		flow,
		openExternal,
		respondingRequestId,
		respond,
		copyUrl,
		copiedUrl,
		activeInput,
		activeInputLabelId,
		showSecret,
		activeInputValue,
		revealingSecret,
		setInputDraft,
		setRevealedSecret,
		ime,
		canSubmit,
		inputDraft,
		revealedSecret,
		toggleSecretVisibility,
		responseError,
	};
}
