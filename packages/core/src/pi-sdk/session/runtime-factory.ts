import type { PiResourceReloadMode } from "@ling/contracts/session";
import type { PiModelProjection } from "../models/model-projection";
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	resolveModelScopeWithDiagnostics,
} from "@earendil-works/pi-coding-agent";
import type { SessionRef } from "@ling/contracts/session";
import type { PiDiagnostic } from "@ling/contracts/pi-diagnostic";
import { createLogger } from "../../logger";
import { getPiAgentDir } from "../agent-info";
import { assertNoBlockingDiagnostics, collectServiceDiagnostics } from "../diagnostics";
import type { PiSettings } from "../settings/settings";
import type {
	PiAgentSession,
	PiAgentSessionServices,
	PiAgentSessionRuntime,
	PiCreateAgentSessionRuntimeFactory,
	PiSessionManager,
} from "../types";

const log = createLogger("pi-sdk-runtime-factory");

/** Session generations acquire and release their own service graph through the project owner. */
interface PiRuntimeServiceAccess {
	acquirePiRuntimeServices(
		cwd: string,
		options: {
			sessionManager: PiSessionManager;
			extensionFlagValues?: Map<string, boolean | string>;
			mode?: PiResourceReloadMode;
		},
	): Promise<PiAgentSessionServices>;
	releasePiRuntimeServices(services: PiAgentSessionServices): void;
}

export interface PiSessionProjectAccess extends PiRuntimeServiceAccess {
	getOpenProjectCwd(cwd: string): string;
}

export interface RuntimeGenerationState {
	mode?: PiResourceReloadMode;
	model: { provider: string; id: string } | null;
	thinkingLevel: PiAgentSession["thinkingLevel"];
	scopedModels: { provider: string; id: string; thinkingLevel?: PiAgentSession["thinkingLevel"] }[];
	activeToolNames: string[];
	extensionFlagValues: Map<string, boolean | string>;
}

export interface InitialRuntimeSelection {
	model?: { provider: string; id: string };
	thinkingLevel?: PiAgentSession["thinkingLevel"];
}

type PiSessionStartEvent = NonNullable<Parameters<PiCreateAgentSessionRuntimeFactory>[0]["sessionStartEvent"]>;

function restoreReloadToolSelection(
	session: PiAgentSession,
	previousActiveToolNames: readonly string[],
	configuredBuiltIns: string[] | null,
): void {
	const tools = session.getAllTools();
	const availableNames = new Set(tools.map((tool) => tool.name));
	// `defaultTools` is a global floor, not a seed: a session that reloads must land on the
	// configured built-in set even if the user had toggled tools inside it, otherwise the
	// setting would silently apply to new sessions only and drift per session from there.
	const activeNames = configuredBuiltIns
		? configuredBuiltIns.filter((name) => availableNames.has(name))
		: previousActiveToolNames.filter((name) => availableNames.has(name));
	// Either way, keep tools contributed by newly loaded extensions: `defaultTools` only
	// governs Pi's built-ins, and dropping extension tools would disable them on every reload.
	for (const tool of tools) {
		if (tool.sourceInfo.source !== "builtin" && tool.sourceInfo.source !== "sdk") activeNames.push(tool.name);
	}
	session.setActiveToolsByName([...new Set(activeNames)]);
}

function installNextTurnAbortGuard(session: PiAgentSession): void {
	const prepareNextTurnWithContext = session.agent.prepareNextTurnWithContext;
	if (!prepareNextTurnWithContext) return;
	session.agent.prepareNextTurnWithContext = async (turn, signal) => {
		// Pi's next-turn refresh owns native mid-run compaction. Reject an already
		// aborted run before entering it, otherwise stopping during a large tool can
		// launch a summary request and delay settlement.
		signal?.throwIfAborted();
		return await prepareNextTurnWithContext(turn, signal);
	};
}

export function sessionManagerTreeState(manager: PiSessionManager): string {
	return JSON.stringify({
		sessionId: manager.getSessionId(),
		leafId: manager.getLeafId(),
		entries: manager.getEntries(),
	});
}

export async function createRuntimeWithoutReloadBootstrap<Result>(
	manager: PiSessionManager,
	create: () => Promise<Result>,
): Promise<Result> {
	const appendModelChange = manager.appendModelChange;
	const appendThinkingLevelChange = manager.appendThinkingLevelChange;
	const ownsAppendModelChange = Object.hasOwn(manager, "appendModelChange");
	const ownsAppendThinkingLevelChange = Object.hasOwn(manager, "appendThinkingLevelChange");
	const existingLeafId = manager.getLeafId() ?? "ling-empty-session-reload";

	// Pi appends constructor-owned bootstrap entries for empty sessions and a
	// thinking entry for legacy message-bearing sessions that do not have one.
	// A resource reload must rebuild either shape without changing its existing
	// tree. Suppress only those two constructor writes while preserving the same
	// SessionManager instance for the new generation.
	manager.appendModelChange = () => existingLeafId;
	manager.appendThinkingLevelChange = () => existingLeafId;
	try {
		return await create();
	} finally {
		if (ownsAppendModelChange) manager.appendModelChange = appendModelChange;
		else Reflect.deleteProperty(manager, "appendModelChange");
		if (ownsAppendThinkingLevelChange) manager.appendThinkingLevelChange = appendThinkingLevelChange;
		else Reflect.deleteProperty(manager, "appendThinkingLevelChange");
	}
}

function runtimeModelKey(provider: string, id: string): string {
	return JSON.stringify([provider, id]);
}

export function runtimeDiagnostics(runtime: PiAgentSessionRuntime): PiDiagnostic[] {
	return collectServiceDiagnostics(runtime.services);
}

export function createPiRuntimeFactory({
	projects,
	modelProjection,
	getPiDefaultTools,
}: {
	projects: PiRuntimeServiceAccess;
	modelProjection: PiModelProjection;
	getPiDefaultTools: PiSettings["getPiDefaultTools"];
}) {
	const { acquirePiRuntimeServices, releasePiRuntimeServices } = projects;
	const { projectAvailableModels } = modelProjection;

	async function createAgentSessionWithProjectedAvailability(
		options: Parameters<typeof createAgentSessionFromServices>[0],
	): ReturnType<typeof createAgentSessionFromServices> {
		const runtime = options.services.modelRuntime;
		const projectedModels = projectAvailableModels(runtime);
		const availableKeys = new Set(projectedModels.map((model) => runtimeModelKey(model.provider, model.id)));
		const availableProviders = new Set(projectedModels.map((model) => model.provider));
		const getAvailable = runtime.getAvailable;
		const hasConfiguredAuth = runtime.hasConfiguredAuth;
		const ownsGetAvailable = Object.hasOwn(runtime, "getAvailable");
		const ownsHasConfiguredAuth = Object.hasOwn(runtime, "hasConfiguredAuth");

		// Pi's initial-model resolver consumes ModelRuntime's synchronous auth snapshot.
		// A second project can make one stored credential ambiguous after that snapshot
		// was populated. Present Ling's live, fail-closed projection during construction
		// so Pi keeps its normal default/fallback ordering without selecting that stale model.
		runtime.getAvailable = async (providerId, operationOptions) => {
			// Keep Pi's cancellable auth/read contract even though this construction-only
			// projection is synchronous and deliberately avoids a second credential refresh.
			operationOptions?.signal?.throwIfAborted();
			return runtime
				.getAvailableSnapshot()
				.filter(
					(model) =>
						(providerId === undefined || model.provider === providerId) &&
						availableKeys.has(runtimeModelKey(model.provider, model.id)),
				);
		};
		runtime.hasConfiguredAuth = (providerId) =>
			availableProviders.has(providerId) && hasConfiguredAuth.call(runtime, providerId);
		try {
			let scopedModels = options.scopedModels;
			if (scopedModels === undefined) {
				const patterns = options.services.settingsManager.getEnabledModels();
				if (patterns && patterns.length > 0) {
					const resolved = await resolveModelScopeWithDiagnostics(patterns, runtime);
					scopedModels = resolved.scopedModels;
					for (const diagnostic of resolved.diagnostics) {
						options.services.diagnostics.push({ type: diagnostic.type, message: diagnostic.message });
					}
				}
			}
			return await createAgentSessionFromServices({
				...options,
				...(scopedModels === undefined ? {} : { scopedModels }),
			});
		} finally {
			if (ownsGetAvailable) runtime.getAvailable = getAvailable;
			else Reflect.deleteProperty(runtime, "getAvailable");
			if (ownsHasConfiguredAuth) runtime.hasConfiguredAuth = hasConfiguredAuth;
			else Reflect.deleteProperty(runtime, "hasConfiguredAuth");
		}
	}

	function createRuntimeFactory(
		initialGeneration: RuntimeGenerationState | null = null,
		initialSelection: InitialRuntimeSelection | null = null,
	): PiCreateAgentSessionRuntimeFactory {
		let pendingGeneration = initialGeneration;
		let pendingSelection = initialSelection;
		return async ({ cwd, sessionManager, sessionStartEvent }) => {
			const generation = pendingGeneration;
			const selection = pendingSelection;
			pendingGeneration = null;
			pendingSelection = null;
			const services = await acquirePiRuntimeServices(cwd, {
				sessionManager,
				...(generation ? { extensionFlagValues: new Map(generation.extensionFlagValues), mode: generation.mode } : {}),
			});
			try {
				const availableModelKeys = new Set(
					projectAvailableModels(services.modelRuntime).map((model) => runtimeModelKey(model.provider, model.id)),
				);
				const generationModel = generation?.model
					? services.modelRuntime.getModel(generation.model.provider, generation.model.id)
					: undefined;
				const model = generation
					? generationModel && availableModelKeys.has(runtimeModelKey(generationModel.provider, generationModel.id))
						? generationModel
						: undefined
					: selection?.model
						? services.modelRuntime.getModel(selection.model.provider, selection.model.id)
						: undefined;
				if (
					selection?.model &&
					(!model || !availableModelKeys.has(runtimeModelKey(selection.model.provider, selection.model.id)))
				) {
					throw new Error(
						`Selected model is unavailable for this project: ${selection.model.provider}/${selection.model.id}`,
					);
				}
				const scopedModels = generation?.scopedModels.flatMap((entry) => {
					const scopedModel = services.modelRuntime.getModel(entry.provider, entry.id);
					return scopedModel && availableModelKeys.has(runtimeModelKey(scopedModel.provider, scopedModel.id))
						? [{ model: scopedModel, ...(entry.thinkingLevel ? { thinkingLevel: entry.thinkingLevel } : {}) }]
						: [];
				});
				const sessionResult = await createAgentSessionWithProjectedAvailability({
					services,
					sessionManager,
					...(sessionStartEvent ? { sessionStartEvent } : {}),
					...(model ? { model } : {}),
					...(generation
						? { thinkingLevel: generation.thinkingLevel }
						: selection?.thinkingLevel
							? { thinkingLevel: selection.thinkingLevel }
							: {}),
					...(scopedModels ? { scopedModels } : {}),
				});
				installNextTurnAbortGuard(sessionResult.session);
				if (generation)
					restoreReloadToolSelection(sessionResult.session, generation.activeToolNames, getPiDefaultTools());
				return { ...sessionResult, services, diagnostics: services.diagnostics };
			} catch (error) {
				releasePiRuntimeServices(services);
				throw error;
			}
		};
	}

	async function createRuntimeForSession(
		ref: SessionRef,
		sessionManager: PiSessionManager,
		generation: RuntimeGenerationState | null = null,
		sessionStartEvent?: PiSessionStartEvent,
		initialSelection: InitialRuntimeSelection | null = null,
	): Promise<PiAgentSessionRuntime> {
		const runtime = await createAgentSessionRuntime(createRuntimeFactory(generation, initialSelection), {
			cwd: ref.cwd,
			agentDir: getPiAgentDir(),
			sessionManager,
			...(sessionStartEvent ? { sessionStartEvent } : {}),
		});
		try {
			assertNoBlockingDiagnostics(`Failed to create session ${ref.sessionId}`, runtimeDiagnostics(runtime));
			return runtime;
		} catch (error) {
			try {
				await runtime.dispose();
			} catch (disposeError) {
				log.error(`failed to dispose rejected runtime for session ${ref.sessionId}:`, disposeError);
				try {
					runtime.session.dispose();
				} catch (sessionDisposeError) {
					log.error(`failed to force-dispose rejected session ${ref.sessionId}:`, sessionDisposeError);
				}
			}
			releasePiRuntimeServices(runtime.services);
			throw error;
		}
	}
	return { createRuntimeForSession };
}

export type PiRuntimeFactory = ReturnType<typeof createPiRuntimeFactory>;
