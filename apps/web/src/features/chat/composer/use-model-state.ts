import { useDomainApi } from "@renderer/lib/host-api-context";
import type { ModelState, SessionRef, ThinkingLevel } from "@ling/contracts/session";
import { sessionKey } from "@ling/contracts/session-ref";
import { formatRequestError } from "@renderer/lib/errors";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	createLatestSessionRequestFence,
	createSessionMutationBarrier,
	reconcileFailedSessionMutation,
} from "../latest-session-request";

interface SessionModelView {
	identityKey: string;
	/** A runtime rollover mints a new identity key for the same session; this one survives it. */
	sessionKey: string;
	state: ModelState | null;
	error: string | null;
}

interface SessionModelRuntimeBinding {
	runtimeId: string | null;
	generation: number;
}

function modelRuntimeIdentityKey(ref: SessionRef | null, runtimeId: string | null, generation: number): string | null {
	if (!ref || runtimeId === null) return null;
	return JSON.stringify([sessionKey(ref), runtimeId, generation]);
}

export function useModelState(ref: SessionRef | null, binding: SessionModelRuntimeBinding) {
	const hostSessionApi = useDomainApi("session");
	const hostModelsApi = useDomainApi("models");

	const [view, setView] = useState<SessionModelView | null>(null);
	const requestFenceRef = useRef<ReturnType<typeof createLatestSessionRequestFence> | null>(null);
	requestFenceRef.current ??= createLatestSessionRequestFence();
	const requestFence = requestFenceRef.current;
	const mutationBarrierRef = useRef<ReturnType<typeof createSessionMutationBarrier> | null>(null);
	mutationBarrierRef.current ??= createSessionMutationBarrier();
	const mutationBarrier = mutationBarrierRef.current;
	const currentIdentityKey = modelRuntimeIdentityKey(ref, binding.runtimeId, binding.generation);
	const currentIdentityKeyRef = useRef(currentIdentityKey);
	currentIdentityKeyRef.current = currentIdentityKey;

	useEffect(() => {
		if (!ref || binding.runtimeId === null) {
			requestFence.invalidate();
			// A runtime rollover drops the binding for a beat before the new generation reports in.
			// Holding the last state for the same session keeps the model and thinking controls
			// mounted and the context percentage rendered; clearing collapses the toolbar row and
			// re-expands it a frame later. Any other session still clears.
			setView((current) => (ref && current?.sessionKey === sessionKey(ref) ? current : null));
			return;
		}
		const refKey = sessionKey(ref);
		const identityKey = modelRuntimeIdentityKey(ref, binding.runtimeId, binding.generation);
		if (identityKey === null) throw new Error("Active model runtime identity is missing");
		const requestBinding = { ref, runtimeId: binding.runtimeId, generation: binding.generation };
		let refreshRevision = 0;
		const fetchState = () => {
			const requestedRevision = ++refreshRevision;
			void (async () => {
				await mutationBarrier.waitForCommittedMutations(identityKey);
				if (requestedRevision !== refreshRevision || currentIdentityKeyRef.current !== identityKey) return;
				const request = requestFence.begin(identityKey);
				try {
					const next = await hostSessionApi.getModelState(requestBinding);
					if (!requestFence.isCurrent(request, currentIdentityKeyRef.current)) return;
					setView({ identityKey: request.refKey, sessionKey: refKey, state: next, error: null });
				} catch (cause) {
					if (!requestFence.isCurrent(request, currentIdentityKeyRef.current)) return;
					setView((current) => ({
						identityKey: request.refKey,
						sessionKey: refKey,
						state: current?.sessionKey === refKey ? current.state : null,
						error: formatRequestError(cause),
					}));
				}
			})();
		};
		fetchState();
		// Credentials changed in settings (login/API key) — the available-model list is stale.
		const unsubscribeModels = hostModelsApi.onChanged(fetchState);
		// Package/skill reloads can register extension-owned providers without changing
		// global models.json. Refresh from the session runtime after its catalog rebuilds.
		const unsubscribeSession = hostSessionApi.onEvent((envelope) => {
			if (
				sessionKey(envelope.ref) === refKey &&
				envelope.runtimeId === binding.runtimeId &&
				envelope.generation === binding.generation &&
				envelope.event.type === "commandsChanged"
			) {
				fetchState();
			}
		});
		return () => {
			refreshRevision += 1;
			requestFence.invalidate();
			unsubscribeModels();
			unsubscribeSession();
		};
	}, [hostSessionApi, hostModelsApi, ref, binding.runtimeId, binding.generation, requestFence, mutationBarrier]);

	/** setModel and setThinkingLevel differ only in which IPC call they issue; the fence,
	 * barrier, staleness check and failure reconciliation are identical. */
	const runModelMutation = useCallback(
		async (invoke: (binding: { ref: SessionRef; runtimeId: string; generation: number }) => Promise<ModelState>) => {
			const runtimeId = binding.runtimeId;
			if (!ref || runtimeId === null) return null;
			const identityKey = modelRuntimeIdentityKey(ref, runtimeId, binding.generation);
			if (identityKey === null) return null;
			const requestBinding = { ref, runtimeId, generation: binding.generation };
			const request = requestFence.begin(identityKey);
			try {
				const next = await mutationBarrier.track(identityKey, invoke(requestBinding));
				if (!requestFence.isCurrent(request, currentIdentityKeyRef.current)) return null;
				setView({ identityKey: request.refKey, sessionKey: sessionKey(ref), state: next, error: null });
				return next;
			} catch (cause) {
				const error = formatRequestError(cause);
				const reconciliation = await reconcileFailedSessionMutation({
					refKey: identityKey,
					request,
					requestFence,
					mutationBarrier,
					currentRefKey: () => currentIdentityKeyRef.current,
					readCommittedState: () => hostSessionApi.getModelState(requestBinding),
				});
				if (reconciliation.type === "stale") return null;
				setView((current) => ({
					identityKey: request.refKey,
					sessionKey: sessionKey(ref),
					state:
						reconciliation.type === "reconciled"
							? reconciliation.state
							: current?.identityKey === request.refKey
								? current.state
								: null,
					error,
				}));
				return null;
			}
		},
		[hostSessionApi, ref, binding.runtimeId, binding.generation, requestFence, mutationBarrier],
	);

	const setModel = useCallback(
		(provider: string, modelId: string) =>
			runModelMutation((requestBinding) => hostSessionApi.setModel({ ...requestBinding, provider, modelId })),
		[hostSessionApi, runModelMutation],
	);

	const setThinkingLevel = useCallback(
		async (level: ThinkingLevel) => {
			await runModelMutation((requestBinding) => hostSessionApi.setThinkingLevel({ ...requestBinding, level }));
		},
		[hostSessionApi, runModelMutation],
	);

	// Gate on the session, not the runtime binding: a rollover (sessionReplaced) mints a new
	// identity key while the model and thinking level are unchanged, and dropping to null there
	// unmounts the toolbar's model/thinking controls, so the row collapses and re-expands around
	// the re-fetch. A real session switch still clears it, because the session key differs.
	const currentSessionKey = ref ? sessionKey(ref) : null;
	const currentView = view !== null && view.sessionKey === currentSessionKey ? view : null;
	return {
		state: currentView?.state ?? null,
		error: currentView?.error ?? null,
		setModel,
		setThinkingLevel,
	};
}
