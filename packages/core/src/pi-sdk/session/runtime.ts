import type { PiDiagnostic } from "@ling/contracts/pi-diagnostic";
import type { SessionRef } from "@ling/contracts/session";
import { throwAggregateFailures } from "@ling/core/ling-error";
import type { SessionRuntimePort } from "@ling/core/pi-protocol/runtime-port";
import type {
	SessionRuntimeEvent,
	SessionRuntimeReplacementCoordinator,
	SessionRuntimeReplacementEvent,
	SessionRuntimeResourceSnapshot,
	SessionRuntimeTranscriptInvalidationReason,
	SessionRuntimeTranscriptProjectionReason,
} from "@ling/core/pi-protocol/runtime-types";
import { createLogger } from "../../logger";
import { assertNoBlockingDiagnostics } from "../diagnostics";
import { createPiExtensionBindings } from "../extensions/extension-bindings";
import type { PiExtensionUi } from "../extensions/extension-ui-context";
import { resolvePiMarkdownWidth } from "../extensions/markdown-transformer";
import type { PiModelProjection } from "../models/model-projection";
import type { PiAgentSession, PiAgentSessionRuntime } from "../types";
import { createPiRuntimeBoundResources } from "./runtime-bound-resources";
import { createPiRuntimeCommands } from "./runtime-commands";
import { createRuntimeCompanionServices } from "./runtime-companion-services";
import { subscribePiRuntimeEvents } from "./runtime-event-subscription";
import { createPiRuntimeExtensionUi } from "./runtime-extension-ui";
import type { PiSessionProjectAccess } from "./runtime-factory";
import { type PiRuntimeFactory, runtimeDiagnostics } from "./runtime-factory";
import {
	type PiSessionLifecycleState,
	sessionLifecycleConflict,
	sessionReplacementBusy,
	sessionResourceReloadBusy,
} from "./runtime-lifecycle";
import { createPiRuntimeOperationCoordinator, type PiRuntimeOperationCoordinator } from "./runtime-operations";
import { type PiRuntimeProjection, projectPiRuntimeDiagnostics } from "./runtime-projection";
import { createPiRuntimeQueries } from "./runtime-queries";
import { createPiRuntimeReplacement } from "./runtime-replacement";
import { createPiRuntimeResourceReload, type PiRuntimeResourceReload } from "./runtime-resource-reload";
import { createPiRuntimeSessionActions } from "./runtime-session-actions";
import { probeSessionIdentity } from "./session-identity";
import { projectPiToolResult } from "./session-message-projector";
import type { PiTurnLifecycle } from "./turn-lifecycle";

const log = createLogger("pi-sdk");

type SessionRuntimeReplacementListener = (event: SessionRuntimeReplacementEvent) => void;
type SessionRuntimeSnapshotChangedListener = (ref: SessionRef) => void;
type SessionRuntimeTranscriptInvalidatedListener = (
	ref: SessionRef,
	reason: SessionRuntimeTranscriptInvalidationReason,
) => void;
type SessionRuntimeTranscriptProjectionChangedListener = (
	ref: SessionRef,
	reason: SessionRuntimeTranscriptProjectionReason,
) => void;
type SessionRuntimeLifecycleFailureListener = (
	ref: SessionRef,
	error: unknown,
	relatedRefs: readonly SessionRef[],
) => void;

export type PiSessionRuntimeHandle = ReturnType<typeof createPiSessionRuntimeHandle>;

export function createPiSessionRuntimeHandle(
	{
		extensionUi,
		projects,
		turnLifecycle,
		modelProjection,
		runtimeFactory,
		projections,
	}: {
		extensionUi: PiExtensionUi;
		projects: Pick<PiSessionProjectAccess, "getOpenProjectCwd" | "releasePiRuntimeServices">;
		turnLifecycle: PiTurnLifecycle;
		modelProjection: PiModelProjection;
		runtimeFactory: PiRuntimeFactory;
		projections: PiRuntimeProjection;
	},
	ref: SessionRef,
	runtime: PiAgentSessionRuntime,
	createdAt = Date.now(),
) {
	const { resetExtensionUiState } = extensionUi.bridge;
	const { disposePiExtensionUiContext, preparePiExtensionUiShutdown, cancelPiExtensionUiInteractions } = extensionUi;
	const { disposePiExtensionUiViewport } = extensionUi.customPanels;
	const { getPiMarkdownViewportColumns } = extensionUi.viewports;

	const { getOpenProjectCwd } = projects;

	let ownedRuntime = runtime;
	let appliedCacheWarmingMode = runtime.session.settingsManager.getCacheWarmingMode();
	const ownedSnapshotChangedListeners = new Set<SessionRuntimeSnapshotChangedListener>();
	const ownedTranscriptInvalidatedListeners = new Set<SessionRuntimeTranscriptInvalidatedListener>();
	const ownedTranscriptProjectionChangedListeners = new Set<SessionRuntimeTranscriptProjectionChangedListener>();
	let ownedResourceReload: PiRuntimeResourceReload;
	let ownedOperations: PiRuntimeOperationCoordinator;
	let ownedRuntimeDisposePromise: Promise<void> | null = null;
	let ownedDisposePromise: Promise<void> | null = null;
	const ownedSessionDiagnostics: PiDiagnostic[] = [];
	const ownedBoundResources = createPiRuntimeBoundResources(runtime.services, {
		disposeExtensionUiContext: disposePiExtensionUiContext,
		releaseRuntimeServices: projects.releasePiRuntimeServices,
		turnLifecycle,
		onRunSettled: () => ownedResourceReload.emitDeferredIdleEdge(),
	});
	const ownedReplacement = createPiRuntimeReplacement(ref, {
		getActiveResourceReload: () => ownedResourceReload.active,
		getOperationCounts: () => ({
			active: ownedOperations.activeCount,
			activePrompts: ownedOperations.activePromptCount,
			pendingMutations: ownedOperations.pendingMutationCount,
		}),
		assertRuntimeHealthy: () =>
			assertNoBlockingDiagnostics(
				`Failed to replace session ${runtimeHandle.sessionId}`,
				runtimeDiagnostics(ownedRuntime),
			),
		disposeInvalidatedRuntime: () => {
			ownedRuntimeDisposePromise ??= ownedBoundResources.disposeInstalledRuntime(ownedRuntime);
			return ownedRuntimeDisposePromise;
		},
		emitSnapshotChanged,
		emitDeferredResourceReloadIdleEdge: () => ownedResourceReload.emitDeferredIdleEdge(),
	});
	ownedResourceReload = createPiRuntimeResourceReload({
		createRuntimeForSession: runtimeFactory.createRuntimeForSession,
		resetExtensionUiState,
		getRef: () => ownedReplacement.ref,
		getLifecycle: () => ownedReplacement.lifecycle,
		getRuntime: () => ownedRuntime,
		hasUnsettledRun: ownedBoundResources.hasUnsettledRun,
		getOperationCounts: () => ({
			active: ownedOperations.activeCount,
			activePrompts: ownedOperations.activePromptCount,
			pendingMutations: ownedOperations.pendingMutationCount,
		}),
		disposeBoundResources: () => ownedBoundResources.dispose(true),
		installRuntime: (candidate) => {
			ownedRuntime = candidate;
			appliedCacheWarmingMode = candidate.session.settingsManager.getCacheWarmingMode();
			ownedRuntimeDisposePromise = null;
			// The reload's own invariant assertions run after this and can throw before
			// the rebind; own the candidate's lease first so fail-closed releases it.
			ownedBoundResources.claimRuntimeServices(candidate);
			installRuntimeLifecycle(candidate);
		},
		bindRuntimeSession,
		failClosed: failClosedResourceReload,
		emitSnapshotChanged,
		emitTranscriptInvalidated: () => emitTranscriptInvalidated("reload"),
	});
	ownedOperations = createPiRuntimeOperationCoordinator({
		assertCanStart: () => {
			if (ownedReplacement.lifecycle !== "active") {
				throw sessionLifecycleConflict("access", ownedReplacement.lifecycle);
			}
		},
		getActiveReload: () => ownedResourceReload.active,
		assertCanRunSynchronously: (operation) => {
			if (ownedResourceReload.active) {
				throw sessionResourceReloadBusy(
					runtimeHandle.ref,
					`Cannot ${operation} while session ${runtimeHandle.sessionId} is reloading`,
				);
			}
			if (ownedReplacement.lifecycle !== "active") {
				throw sessionLifecycleConflict("access", ownedReplacement.lifecycle);
			}
		},
		onReleased: () => ownedResourceReload.emitDeferredIdleEdge(),
	});
	const ownedSessionActions = createPiRuntimeSessionActions({
		getSession: () => ownedRuntime.session,
		operations: ownedOperations,
		queueMirror: (sessionId) => ownedBoundResources.queueMirror(sessionId),
		emitTreeNavigation: () => emitTranscriptInvalidated("treeNavigation"),
	});
	const queries = createPiRuntimeQueries({
		runtime: () => ownedRuntime,
		diagnostics: ownedSessionDiagnostics,
		queue: () => ownedBoundResources.queueMirror(ownedRuntime.session.sessionManager.getSessionId()).project(),
		assertReadable: assertRuntimeGenerationReadable,
		markdownWidth,
		isBusy,
		projections,
	});
	const commands = createPiRuntimeCommands({
		runtime: () => ownedRuntime,
		operations: ownedOperations,
		isActive: () => ownedReplacement.lifecycle === "active",
		emitSnapshotChanged,
		projectModelState: projections.projectPiRuntimeModelState,
		sessionActions: ownedSessionActions,
	});
	const extensionControls = createPiRuntimeExtensionUi({
		runtime: () => ownedRuntime,
		ref: () => ownedReplacement.ref,
		extensionUi,
		operations: ownedOperations,
		isDisposed: () => ownedReplacement.lifecycle === "disposed",
		assertAvailable: assertRuntimeGenerationAvailable,
		canUpdateMirror: canUpdateExtensionUiMirror,
		emitTranscriptProjectionChanged,
	});
	const runtimeHandle = {
		...createRuntimeCompanionServices({
			session: () => ownedRuntime.session,
			operations: ownedOperations,
			isBusy,
			emitSnapshotChanged,
		}),
		...ownedSessionActions,
		...queries,
		// Catalog notifications can arrive before reload has rebound the session.
		getModelState: () => ownedOperations.run(queries.getModelState),
		...commands,
		...extensionControls,
		createdAt,
		get ref(): SessionRef {
			return ownedReplacement.ref;
		},
		get lifecycleState(): PiSessionLifecycleState {
			return ownedReplacement.lifecycle;
		},
		getResourceSnapshot,
		get cwd(): string {
			return ownedRuntime.cwd;
		},
		get sessionId(): string {
			return ownedRuntime.session.sessionManager.getSessionId();
		},
		get sessionFile(): string | undefined {
			return ownedRuntime.session.sessionFile;
		},
		get diagnostics(): readonly PiDiagnostic[] {
			return projectPiRuntimeDiagnostics(ownedRuntime, ownedSessionDiagnostics);
		},
		addSessionDiagnostics,
		onSessionReplaced,
		onSnapshotChanged,
		onTranscriptInvalidated,
		onTranscriptProjectionChanged,
		onLifecycleFailed,
		setReplacementCoordinator,
		bindExtensions,
		isBusy,
		refreshFromDisk,
		async refreshSettings() {
			const session = ownedRuntime.session;
			const mode = session.settingsManager.getCacheWarmingMode();
			if (mode === appliedCacheWarmingMode) return;
			// The SDK setter also cancels scheduled/in-flight warming when the mode changes.
			session.setCacheWarmingMode(mode);
			await session.settingsManager.flush();
			const errors = session.settingsManager.drainErrors();
			throwAggregateFailures(
				errors.map(({ error }) => error),
				"Failed to apply Pi cache warming settings",
			);
			if (ownedRuntime.session === session) appliedCacheWarmingMode = mode;
		},
		reloadResources,
		async readToolResult(entryId: string) {
			assertRuntimeGenerationReadable();
			return projectPiToolResult(ownedRuntime.session, entryId, markdownWidth());
		},
		subscribe,
		abort,
		dispose,
	};
	installRuntimeLifecycle(runtime);
	return runtimeHandle satisfies SessionRuntimePort;
	function installRuntimeLifecycle(runtime: PiAgentSessionRuntime): void {
		runtime.setBeforeSessionInvalidate(() => {
			// A background Pi run can already report idle while its settled hooks are
			// still running. Keep the original generation usable when replacement races it.
			if (ownedBoundResources.hasUnsettledRun()) throw sessionReplacementBusy(ownedReplacement.ref);
			ownedReplacement.markGenerationInvalidated();
			try {
				ownedBoundResources.dispose(true);
			} finally {
				// Disposing the GUI capability revokes future extension writes, but the
				// projected snapshot is owned separately. Clear it at Pi's generation
				// boundary so a same-ref refresh cannot inherit the previous runtime's UI.
				resetExtensionUiState(ownedReplacement.ref);
			}
		});
		runtime.setRebindSession(bindRuntimeSession);
	}

	function getResourceSnapshot(): SessionRuntimeResourceSnapshot {
		const resources = ownedBoundResources.snapshot();
		const replacement = ownedReplacement.snapshot();
		return {
			...replacement,
			snapshotChangedListeners: ownedSnapshotChangedListeners.size,
			transcriptInvalidatedListeners: ownedTranscriptInvalidatedListeners.size,
			transcriptProjectionChangedListeners: ownedTranscriptProjectionChangedListeners.size,
			...resources,
		};
	}

	function addSessionDiagnostics(diagnostics: readonly PiDiagnostic[]): void {
		ownedSessionDiagnostics.push(...diagnostics);
	}

	function onSessionReplaced(listener: SessionRuntimeReplacementListener): () => void {
		return ownedReplacement.onReplaced(listener);
	}

	function onSnapshotChanged(listener: SessionRuntimeSnapshotChangedListener): () => void {
		ownedSnapshotChangedListeners.add(listener);
		return () => ownedSnapshotChangedListeners.delete(listener);
	}

	function onTranscriptInvalidated(listener: SessionRuntimeTranscriptInvalidatedListener): () => void {
		ownedTranscriptInvalidatedListeners.add(listener);
		return () => ownedTranscriptInvalidatedListeners.delete(listener);
	}

	function onTranscriptProjectionChanged(listener: SessionRuntimeTranscriptProjectionChangedListener): () => void {
		ownedTranscriptProjectionChangedListeners.add(listener);
		return () => ownedTranscriptProjectionChangedListeners.delete(listener);
	}

	function onLifecycleFailed(listener: SessionRuntimeLifecycleFailureListener): () => void {
		return ownedReplacement.onLifecycleFailed(listener);
	}

	function setReplacementCoordinator(coordinator: SessionRuntimeReplacementCoordinator): () => void {
		return ownedReplacement.setCoordinator(coordinator);
	}

	async function bindExtensions(): Promise<void> {
		await bindRuntimeSession(ownedRuntime.session);
	}

	async function bindRuntimeSession(session: PiAgentSession): Promise<void> {
		// AgentSessionRuntime has already installed the newly created service graph
		// before it asks the host to rebind. The invalidate hook released the previous
		// graph, so this handle now owns a fresh lease again. Claim it ahead of the
		// reservation await, not inside bind(): a rejected reservation must fail closed
		// through runtime.dispose(), whose invalidate hook can only release what is owned.
		const nextRef = { cwd: ownedRuntime.cwd, sessionId: session.sessionManager.getSessionId() };
		ownedBoundResources.claimRuntimeServices(ownedRuntime);
		const preparedBinding = await ownedReplacement.prepareBinding(nextRef);

		await ownedBoundResources.bind(nextRef, ownedRuntime, () => createExtensionBindings(nextRef));
		// Rebinding commits the new AgentSession before AgentSessionRuntime finishes an
		// optional withSession callback. Host projections must be able to subscribe and
		// read that committed generation while mutations remain fenced by `replacing`.
		await preparedBinding?.commit();
	}

	function createExtensionBindings(ref: SessionRef) {
		return createPiExtensionBindings(extensionUi, modelProjection, ref, ownedRuntime, {
			newSession: (options) => ownedReplacement.replace("new", null, () => ownedRuntime.newSession(options), true),
			fork: (entryId, options) =>
				ownedReplacement.replace("fork", null, () => ownedRuntime.fork(entryId, options), true),
			navigateTree: (targetId, options) => ownedSessionActions.navigateTree(targetId, options),
			switchSession: async (sessionPath, options) => {
				// Probe identity without SessionManager.open — the real switch opens the file
				// once inside replace(). A retained probe manager would double-open and leak
				// on busy/lifecycle rejection.
				const identity = await probeSessionIdentity(sessionPath);
				const rawCwd = options?.cwdOverride ?? identity.headerCwd ?? ownedRuntime.cwd;
				const targetRef = {
					cwd: getOpenProjectCwd(rawCwd),
					sessionId: identity.sessionId,
				};
				return ownedReplacement.replace(
					"switch",
					targetRef,
					() => ownedRuntime.switchSession(sessionPath, options),
					true,
				);
			},
			reload: () => reloadResourcesFromCommand(),
			extensionError: (error) => {
				ownedResourceReload.recordExtensionError(
					new Error(`Extension ${error.extensionPath} failed during ${error.event}: ${error.error}`),
				);
			},
		});
	}

	function emitSnapshotChanged(): void {
		for (const listener of ownedSnapshotChangedListeners) {
			listener(ownedReplacement.ref);
		}
	}

	function emitTranscriptInvalidated(reason: "treeNavigation" | "reload"): void {
		for (const listener of ownedTranscriptInvalidatedListeners) {
			listener(ownedReplacement.ref, reason);
		}
	}

	function emitTranscriptProjectionChanged(reason: SessionRuntimeTranscriptProjectionReason): void {
		for (const listener of ownedTranscriptProjectionChangedListeners) {
			listener(ownedReplacement.ref, reason);
		}
	}

	function markdownWidth(): number {
		return resolvePiMarkdownWidth(getPiMarkdownViewportColumns(ownedReplacement.ref));
	}

	function assertRuntimeGenerationAvailable(): void {
		ownedResourceReload.assertAvailable();
	}

	function assertRuntimeGenerationReadable(): void {
		if (
			ownedReplacement.lifecycle === "replacing" &&
			ownedReplacement.generationBound &&
			ownedResourceReload.generationAvailable
		) {
			return;
		}
		assertRuntimeGenerationAvailable();
	}

	function canUpdateExtensionUiMirror(): boolean {
		const lifecycle = ownedReplacement.lifecycle;
		if (lifecycle === "disposing" || lifecycle === "disposed") return false;
		if (lifecycle === "replacing" && !ownedReplacement.generationBound) return false;
		// Passive mirrors can skip a rebuilding generation: the renderer keeps its
		// draft/viewport and sends current state after the new binding arrives.
		return ownedResourceReload.generationAvailable;
	}

	function isBusy(): boolean {
		return (
			ownedReplacement.lifecycle !== "active" ||
			ownedResourceReload.active !== null ||
			ownedOperations.activeCount > 0 ||
			ownedOperations.pendingMutationCount > 0 ||
			ownedBoundResources.hasUnsettledRun() ||
			!ownedRuntime.session.isIdle
		);
	}

	function refreshFromDisk(): Promise<void> {
		const sessionFile = ownedRuntime.session.sessionFile;
		if (!sessionFile) {
			// Nothing persisted yet — the in-memory session is the only copy.
			return Promise.resolve();
		}
		return ownedReplacement.replace("refresh", ownedReplacement.ref, async () => {
			await ownedRuntime.switchSession(sessionFile);
		});
	}

	function reloadResources(): Promise<void> {
		return ownedResourceReload.reload();
	}

	function reloadResourcesFromCommand(): Promise<void> {
		return ownedResourceReload.reloadFromCommand();
	}

	async function failClosedResourceReload(error: unknown, candidate: PiAgentSessionRuntime | null): Promise<void> {
		ownedReplacement.setLifecycle("disposing");
		// Always tear down the installed AgentSessionRuntime. invalidateGeneration already
		// released the bound service lease and session, but leave disposeInstalledRuntime
		// as the single full teardown path (same as dispose()). Dispose a never-installed
		// candidate separately when reconstruction failed after create.
		if (candidate && candidate !== ownedRuntime) {
			try {
				await ownedBoundResources.disposeInstalledRuntime(candidate);
			} catch (disposeError) {
				log.error(`fail-closed candidate disposal failed for session ${runtimeHandle.ref.sessionId}:`, disposeError);
			}
		}
		ownedRuntimeDisposePromise ??= ownedBoundResources.disposeInstalledRuntime(ownedRuntime);
		try {
			await ownedRuntimeDisposePromise;
		} catch (disposeError) {
			log.error(`fail-closed reload disposal failed for session ${runtimeHandle.ref.sessionId}:`, disposeError);
		}
		disposePiExtensionUiViewport(runtimeHandle.ref);
		ownedReplacement.setLifecycle("disposed");
		ownedReplacement.emitLifecycleFailure(error);
	}

	function subscribe(listener: (event: SessionRuntimeEvent) => void): () => void {
		return subscribePiRuntimeEvents(
			{
				session: ownedRuntime.session,
				getMarkdownWidth: () => markdownWidth(),
				onDeferredError: (error) => ownedReplacement.emitLifecycleFailure(error),
				subscribeChangeReview: (changeReviewListener) =>
					ownedBoundResources.subscribeChangeReview(changeReviewListener),
				subscribeQueue: (queueListener) =>
					ownedBoundResources.queueMirror(runtimeHandle.sessionId).subscribe(queueListener),
				queueMirror: () => ownedBoundResources.queueMirror(runtimeHandle.sessionId),
			},
			listener,
		);
	}

	function abort(): Promise<{ restoredTexts: string[] }> {
		return cancelPiExtensionUiInteractions(runtimeHandle.ref, () => ownedSessionActions.abort());
	}

	function dispose(): Promise<void> {
		if (ownedDisposePromise) return ownedDisposePromise;

		ownedReplacement.setLifecycle("disposing");
		const replacement = ownedReplacement.active;
		const resourceReload = ownedResourceReload.active;
		const { runtimeMutations, runtimeOperations } = ownedOperations.captureDrains();
		ownedDisposePromise = (async () => {
			const failures: unknown[] = [];
			const cancelInteractions = () => {
				try {
					preparePiExtensionUiShutdown(runtimeHandle.ref);
				} catch (error) {
					failures.push(error);
				}
			};
			// An extension command may itself be waiting for a panel or dialog. Closing
			// its input only after draining the command would leave both waiting forever.
			cancelInteractions();
			if (resourceReload) {
				try {
					await resourceReload;
				} catch {
					// The reload coordinator owns its error. Disposal still drains the runtime.
				}
			}
			if (replacement) {
				try {
					await replacement;
				} catch {
					// The replacement caller owns its error. Disposal must still finish the
					// currently installed runtime before close/delete can continue.
				}
			}
			// An admitted replacement can have installed another context while closing.
			cancelInteractions();
			try {
				await ownedRuntime.session.abort();
			} catch (error) {
				failures.push(error);
			}
			await ownedBoundResources.waitForRunSettled();
			// Mutations invoked before close either finish against the still-owned
			// generation or reject on the disposing fence. General operations that
			// already claimed the generation must finish before SDK disposal begins.
			if (runtimeMutations) await runtimeMutations;
			if (runtimeOperations) await runtimeOperations;
			ownedRuntimeDisposePromise ??= ownedBoundResources.disposeInstalledRuntime(ownedRuntime);
			try {
				await ownedRuntimeDisposePromise;
			} catch (error) {
				failures.push(error);
			}
			try {
				ownedBoundResources.dispose(false);
			} catch (error) {
				failures.push(error);
			}
			disposePiExtensionUiViewport(runtimeHandle.ref);
			ownedReplacement.setLifecycle("disposed");
			throwAggregateFailures(failures, "Failed to dispose Pi session runtime resources");
		})();
		return ownedDisposePromise;
	}
}
