import type { PiResourceReloadMode } from "@ling/contracts/session";
import { PI_DEFAULT_TOOL_NAMES } from "@ling/contracts/pi-settings";
import type { PiModelProjection } from "../models/model-projection";
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	getAgentDir,
	resolveModelScopeWithDiagnostics,
} from "@earendil-works/pi-coding-agent";
import type { SessionRef } from "@ling/contracts/session-ref";
import type { PiDiagnostic } from "@ling/contracts/pi-diagnostic";
import { createLogger } from "../../logger";
import { assertNoBlockingDiagnostics, collectServiceDiagnostics } from "../diagnostics";
import type {
	PiAgentSession,
	PiAgentSessionServices,
	PiAgentSessionRuntime,
	PiCreateAgentSessionRuntimeFactory,
	PiLoadExtensionsResult,
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
	availableToolNames: string[];
	defaultToolNames: readonly string[];
	extensionFlagValues: Map<string, boolean | string>;
}

export interface InitialRuntimeSelection {
	model?: { provider: string; id: string };
	thinkingLevel?: PiAgentSession["thinkingLevel"];
}

type PiSessionStartEvent = NonNullable<Parameters<PiCreateAgentSessionRuntimeFactory>[0]["sessionStartEvent"]>;

function reloadToolSelection(session: PiAgentSession, previous: RuntimeGenerationState): string[] {
	const tools = session.getAllTools();
	const activeNames = [...previous.activeToolNames];
	// Pi resolves global/project +/- entries. Reload adds new defaults while retaining the
	// session's choices, including enabled tools removed from defaults and manually disabled tools.
	const previousDefaults = new Set(previous.defaultToolNames);
	for (const name of session.settingsManager.getDefaultTools() ?? PI_DEFAULT_TOOL_NAMES) {
		if (!previousDefaults.has(name)) activeNames.push(name);
	}
	const initiallyActive = new Set(session.getActiveToolNames());
	const previousAvailable = new Set(previous.availableToolNames);
	// Preserve newly loaded extensions' default activation without activating opt-in tools.
	for (const tool of tools) {
		if (
			!previousAvailable.has(tool.name) &&
			tool.sourceInfo.source !== "builtin" &&
			tool.sourceInfo.source !== "sdk" &&
			initiallyActive.has(tool.name)
		)
			activeNames.push(tool.name);
	}
	return [...new Set(activeNames)];
}

/** Read tool deltas from Pi's projected branch, including compaction and context edits. */
function recordedToolSelection(session: PiAgentSession): string[] | undefined {
	const names = new Set<string>();
	let declared = false;
	for (const message of session.agent.state.messages) {
		if (message.role !== "system") continue;
		declared = true;
		for (const tool of message.toolsRemoved ?? []) names.delete(tool.name);
		for (const tool of message.toolsAdded ?? []) names.add(tool.name);
	}
	return declared ? [...names] : undefined;
}

/** Restore a generation's selection as asynchronous extension tools register. */
function restoreRuntimeToolSelection(
	session: PiAgentSession,
	runtime: PiLoadExtensionsResult["runtime"],
	previous: RuntimeGenerationState | null,
): void {
	const selected = previous ? reloadToolSelection(session, previous) : recordedToolSelection(session);
	if (!selected) return;
	session.setActiveToolsByName(selected);
	const registered = new Set(session.getAllTools().map((tool) => tool.name));
	const pending = new Set(selected.filter((name) => !registered.has(name)));
	if (pending.size === 0) return;
	let leafId = session.sessionManager.getLeafId();
	const recordedSelection = JSON.stringify(recordedToolSelection(session));

	const refreshTools = runtime.refreshTools;
	const setActiveTools = session.setActiveToolsByName;
	const ownsSetActiveTools = Object.hasOwn(session, "setActiveToolsByName");
	const applySelection: PiAgentSession["setActiveToolsByName"] = (names) => {
		const before = session.getActiveToolNames();
		setActiveTools.call(session, names);
		const active = new Set(session.getActiveToolNames());
		if (before.some((name) => !active.has(name))) cleanup();
	};
	const refresh = () => {
		const currentLeafId = session.sessionManager.getLeafId();
		if (currentLeafId !== leafId) {
			leafId = currentLeafId;
			// Tree navigation restores its own loadout; late registrations belong to that branch.
			if (JSON.stringify(recordedToolSelection(session)) !== recordedSelection) cleanup();
		}
		refreshTools();
		if (pending.size === 0) return;
		const available = new Set(session.getAllTools().map((tool) => tool.name));
		const added = [...pending].filter((name) => available.has(name));
		if (added.length === 0) return;
		for (const name of added) pending.delete(name);
		setActiveTools.call(session, [...session.getActiveToolNames(), ...added]);
		if (pending.size === 0) cleanup();
	};
	const unsubscribe = session.subscribe((event) => {
		// The first run records its available loadout; missing tools must not activate later.
		if (event.type === "agent_start") cleanup();
	});
	const cleanup = runtime.trackEventBusSubscription(() => {
		pending.clear();
		unsubscribe();
		if (runtime.refreshTools === refresh) runtime.refreshTools = refreshTools;
		if (session.setActiveToolsByName === applySelection) {
			if (ownsSetActiveTools) session.setActiveToolsByName = setActiveTools;
			else Reflect.deleteProperty(session, "setActiveToolsByName");
		}
	});
	runtime.refreshTools = refresh;
	session.setActiveToolsByName = applySelection;
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
}: {
	projects: PiRuntimeServiceAccess;
	modelProjection: PiModelProjection;
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
				restoreRuntimeToolSelection(sessionResult.session, sessionResult.extensionsResult.runtime, generation);
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
			agentDir: getAgentDir(),
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
