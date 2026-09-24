import type { PiResourceReloadMode, SessionRef } from "@ling/contracts/session";
import { throwAggregateFailures } from "@ling/core/ling-error";
import { assertNoBlockingDiagnostics } from "../diagnostics";
import type { PiAgentSession, PiAgentSessionRuntime } from "../types";
import {
	type PiRuntimeFactory,
	createRuntimeWithoutReloadBootstrap,
	runtimeDiagnostics,
	type RuntimeGenerationState,
	sessionManagerTreeState,
} from "./runtime-factory";
import { type PiSessionLifecycleState, sessionLifecycleConflict, sessionResourceReloadBusy } from "./runtime-lifecycle";

interface RuntimeResourceReloadHost {
	createRuntimeForSession: PiRuntimeFactory["createRuntimeForSession"];
	resetExtensionUiState(ref: SessionRef): void;
	getRef(): SessionRef;
	getLifecycle(): PiSessionLifecycleState;
	getRuntime(): PiAgentSessionRuntime;
	hasUnsettledRun(): boolean;
	getOperationCounts(): {
		active: number;
		activePrompts: number;
		pendingMutations: number;
	};
	disposeBoundResources(): void;
	installRuntime(runtime: PiAgentSessionRuntime): void;
	bindRuntimeSession(session: PiAgentSession): Promise<void>;
	failClosed(error: unknown, candidate: PiAgentSessionRuntime | null): Promise<void>;
	emitSnapshotChanged(): void;
	emitTranscriptInvalidated(): void;
}

export interface PiRuntimeResourceReload {
	readonly active: Promise<void> | null;
	readonly generationAvailable: boolean;
	assertAvailable(): void;
	reload(mode?: PiResourceReloadMode): Promise<void>;
	reloadFromCommand(): Promise<void>;
	recordExtensionError(error: Error): void;
	emitDeferredIdleEdge(): void;
}

function captureRuntimeGenerationState(
	session: PiAgentSession,
	extensionFlagValues: ReadonlyMap<string, boolean | string>,
): RuntimeGenerationState {
	return {
		model: session.model ? { provider: session.model.provider, id: session.model.id } : null,
		thinkingLevel: session.thinkingLevel,
		scopedModels: session.scopedModels.map((entry) => ({
			provider: entry.model.provider,
			id: entry.model.id,
			...(entry.thinkingLevel ? { thinkingLevel: entry.thinkingLevel } : {}),
		})),
		activeToolNames: session.getActiveToolNames(),
		extensionFlagValues: new Map(extensionFlagValues),
	};
}

export function createPiRuntimeResourceReload(host: RuntimeResourceReloadHost): PiRuntimeResourceReload {
	let active: Promise<void> | null = null;
	let deferredIdleNotification = false;
	let activeErrors: Error[] | null = null;
	let generationAvailable = true;

	const invalidateGeneration = async (runtime: PiAgentSessionRuntime, session: PiAgentSession): Promise<void> => {
		runtime.setBeforeSessionInvalidate(undefined);
		runtime.setRebindSession(undefined);
		const failures: unknown[] = [];
		try {
			host.disposeBoundResources();
		} catch (error) {
			failures.push(error);
		}
		host.resetExtensionUiState(host.getRef());
		try {
			session.dispose();
		} catch (error) {
			failures.push(error);
		}
		throwAggregateFailures(failures, "Failed to invalidate the previous Pi runtime generation");
	};
	const throwExtensionErrors = (): void => {
		const errors = activeErrors ? [...new Map(activeErrors.map((error) => [error.message, error])).values()] : [];
		if (errors.length > 0) {
			throw new AggregateError(
				errors,
				`Failed to reload extensions for session ${host.getRuntime().session.sessionManager.getSessionId()}`,
			);
		}
	};
	const reloadGeneration = async (session: PiAgentSession, mode: PiResourceReloadMode): Promise<void> => {
		const sessionManager = session.sessionManager;
		generationAvailable = false;
		const previousRuntime = host.getRuntime();
		// Flags are captured before shutdown. Model/thinking/tool state is captured
		// after shutdown handlers have had their documented chance to mutate it.
		const extensionFlagValues = new Map(session.extensionRunner.getFlagValues());
		let invalidated = false;
		let candidate: PiAgentSessionRuntime | null = null;
		try {
			if (session.extensionRunner.hasHandlers("session_shutdown")) {
				await session.extensionRunner.emit({
					type: "session_shutdown",
					reason: "reload",
				});
			}
			const generation = { ...captureRuntimeGenerationState(session, extensionFlagValues), mode };
			invalidated = true;
			await invalidateGeneration(previousRuntime, session);
			await previousRuntime.services.settingsManager.reload();
			const managerTreeState = sessionManagerTreeState(sessionManager);
			const createCandidate = () =>
				host.createRuntimeForSession(host.getRef(), sessionManager, generation, {
					type: "session_start",
					reason: "reload",
				});
			candidate = await createRuntimeWithoutReloadBootstrap(sessionManager, createCandidate);
			host.installRuntime(candidate);
			if (candidate.session.sessionManager !== sessionManager) {
				throw new Error("Clean resource reload replaced the live SessionManager");
			}
			if (sessionManagerTreeState(sessionManager) !== managerTreeState) {
				throw new Error("Clean resource reload changed the session tree during reconstruction");
			}
			await host.bindRuntimeSession(candidate.session);
			throwExtensionErrors();
			assertNoBlockingDiagnostics(
				`Failed to reload session ${candidate.session.sessionManager.getSessionId()}`,
				runtimeDiagnostics(candidate),
			);
			generationAvailable = true;
			candidate = null;
		} catch (error) {
			if (invalidated) await host.failClosed(error, candidate);
			else generationAvailable = true;
			throw error;
		}
	};
	const start = (
		permittedRuntimeOperations: number,
		requireOwningPrompt: boolean,
		mode: PiResourceReloadMode = "full",
	): Promise<void> => {
		if (active) return active;
		const lifecycle = host.getLifecycle();
		if (lifecycle !== "active") {
			if (lifecycle === "replacing") deferredIdleNotification = true;
			return Promise.reject(sessionLifecycleConflict("reload", lifecycle));
		}
		const runtime = host.getRuntime();
		const operationCounts = host.getOperationCounts();
		if (
			(requireOwningPrompt && (operationCounts.active !== 1 || operationCounts.activePrompts !== 1)) ||
			operationCounts.pendingMutations > 0 ||
			operationCounts.active > permittedRuntimeOperations ||
			host.hasUnsettledRun() ||
			!runtime.session.isIdle
		) {
			deferredIdleNotification = true;
			return Promise.reject(sessionResourceReloadBusy(host.getRef()));
		}

		const session = runtime.session;
		deferredIdleNotification = false;
		// Publish ownership before any extension lifecycle hook can synchronously
		// re-enter through ctx.reload().
		const work = Promise.resolve().then(async () => {
			activeErrors = [];
			await reloadGeneration(session, mode);
			const current = host.getRuntime();
			assertNoBlockingDiagnostics(
				`Failed to reload session ${current.session.sessionManager.getSessionId()}`,
				runtimeDiagnostics(current),
			);
			host.emitTranscriptInvalidated();
		});
		const operation: Promise<void> = work.finally(() => {
			activeErrors = null;
			if (active === operation) active = null;
		});
		active = operation;
		return operation;
	};

	return {
		get active() {
			return active;
		},
		get generationAvailable() {
			return generationAvailable;
		},
		assertAvailable() {
			const lifecycle = host.getLifecycle();
			if (lifecycle !== "active") {
				throw sessionLifecycleConflict("access", lifecycle);
			}
			if (generationAvailable) return;
			const runtime = host.getRuntime();
			throw sessionResourceReloadBusy(
				host.getRef(),
				`Cannot access session ${runtime.session.sessionManager.getSessionId()} while its resources are reloading`,
			);
		},
		reload(mode = "full") {
			// Joining an in-flight ctx.reload could credit a pre-mutation generation
			// as current, so an external request always schedules a fresh generation.
			if (active) {
				return active.then(
					() => start(0, false, mode),
					() => start(0, false, mode),
				);
			}
			return start(0, false, mode);
		},
		reloadFromCommand() {
			// session_start/session_shutdown hooks run inside the reload they observe.
			// Returning that same promise would make the hook await itself.
			if (active) {
				return Promise.reject(sessionResourceReloadBusy(host.getRef()));
			}
			return start(1, true);
		},
		recordExtensionError(error) {
			activeErrors?.push(error);
		},
		emitDeferredIdleEdge() {
			const lifecycle = host.getLifecycle();
			const runtime = host.getRuntime();
			const counts = host.getOperationCounts();
			if (
				lifecycle !== "active" ||
				counts.active !== 0 ||
				counts.pendingMutations !== 0 ||
				!deferredIdleNotification ||
				host.hasUnsettledRun() ||
				!runtime.session.isIdle
			) {
				return;
			}
			deferredIdleNotification = false;
			host.emitSnapshotChanged();
		},
	};
}
