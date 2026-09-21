import type { SessionMessage } from "@ling/contracts/session";
import type {
	ModelConfiguration,
	ModelConfigurationRequest,
	ModelLoginEvent,
	ProjectModelCatalog,
	ProviderAuthTarget,
} from "@ling/contracts/model";
import type { SkillInfo, SkillsOverview } from "@ling/contracts/skill";
import type { PiDiagnostic } from "@ling/contracts/pi-diagnostic";
import { notifyListeners } from "@ling/core/listeners";
import { pathIdentity } from "@ling/core/paths";
import { createPiDomainWireClient, type PiDomainWireClient } from "@ling/core/pi-protocol/domain-client";
import type { PiCall } from "@ling/core/pi-protocol/methods";
import type {
	PiWorkerDomainEvent,
	PiWorkerEvent,
	PiWorkerProjectPiConfig,
	PiWorkerProjectSnapshot,
} from "@ling/core/pi-protocol/protocol";
import type {
	SessionCatalogDiscovery,
	SessionCatalogFileFingerprint,
	SessionCatalogInfo,
} from "@ling/core/pi-protocol/runtime-types";
import { resolve } from "node:path";

interface ProjectSlot {
	cwd: string;
	state: "open" | "closing";
	operations: Set<Promise<unknown>>;
	closePromise: Promise<void> | null;
}

export interface PiWorkerDomainClient extends Omit<
	PiDomainWireClient,
	| "prepareShutdown"
	| "openProject"
	| "inspectProject"
	| "projectPiConfig"
	| "closeProject"
	| "reloadProjectSettings"
	| "refreshSettingsSnapshots"
	| "listSessions"
	| "discoverSessions"
	| "getModelConfiguration"
	| "listProjectModels"
	| "getApiKey"
	| "removeAuth"
	| "startLogin"
	| "reconcileCredential"
	| "readSkillsOverview"
	| "readProjectSkills"
> {
	prepareShutdown(): Promise<void>;
	openProject(cwd: string): Promise<PiWorkerProjectSnapshot>;
	inspectProject(cwd: string): Promise<PiWorkerProjectSnapshot>;
	projectPiConfig(cwd: string): Promise<PiWorkerProjectPiConfig>;
	closeProject(cwd: string, drain: (canonicalCwd: string) => Promise<void>): Promise<void>;
	listOpenProjectPaths(): string[];
	resolveProject(cwd: string): string;
	withProject<Result>(cwd: string, operation: (canonicalCwd: string) => Promise<Result>): Promise<Result>;
	reloadProjectSettings(projectCwds?: readonly string[]): Promise<void>;
	refreshSettingsSnapshots(): Promise<void>;
	listSessions(cwd: string): Promise<SessionCatalogInfo[]>;
	discoverSessions(
		cwd: string,
		cachedFiles: readonly { path: string; fingerprint: SessionCatalogFileFingerprint }[],
	): Promise<SessionCatalogDiscovery[]>;
	readArchivedSession(cwd: string, sessionFilePath: string, markdownWidth: number): Promise<SessionMessage[]>;
	getModelConfiguration(request: ModelConfigurationRequest): Promise<ModelConfiguration>;
	listProjectModels(cwd: string): Promise<ProjectModelCatalog>;
	getApiKey(target: ProviderAuthTarget): Promise<string | null>;
	removeAuth(target: ProviderAuthTarget): Promise<void>;
	startLogin(
		flowId: string,
		provider: string,
		method: "api_key" | "oauth",
		cwd: string | null,
		admissionSignal?: AbortSignal,
	): Promise<void>;
	reconcileCredential(cwd: string | null): Promise<void>;
	onModelCatalogChanged(listener: () => void): () => void;
	onModelLoginEvent(listener: (flowId: string, event: ModelLoginEvent) => void): () => void;
	onModelOpenExternal(listener: (flowId: string, url: string) => void): () => void;
	readSkillsOverview(): Promise<SkillsOverview>;
	readProjectSkills(cwd: string): Promise<SkillInfo[]>;
	handleEvent(event: PiWorkerEvent): event is PiWorkerDomainEvent;
}

function rememberAlias(aliases: Map<string, string>, alias: string, canonicalCwd: string): void {
	aliases.set(pathIdentity(resolve(alias)), canonicalCwd);
	aliases.set(pathIdentity(resolve(canonicalCwd)), canonicalCwd);
}

function diagnosticsSnapshot(snapshot: PiWorkerProjectSnapshot): PiWorkerProjectSnapshot {
	return {
		cwd: snapshot.cwd,
		diagnostics: snapshot.diagnostics.map((diagnostic: PiDiagnostic) => ({ ...diagnostic })),
	};
}

export function createPiWorkerDomainClient(call: PiCall): PiWorkerDomainClient {
	const projects = new Map<string, ProjectSlot>();
	const aliases = new Map<string, string>();
	const modelCatalogListeners = new Set<() => void>();
	const modelLoginListeners = new Set<(flowId: string, event: ModelLoginEvent) => void>();
	const modelOpenExternalListeners = new Set<(flowId: string, url: string) => void>();
	let eventGeneration = 0;
	let eventSequence = 0;
	let shuttingDown = false;
	let shutdownPreparation: Promise<void> | null = null;

	const assertAcceptingOperations = (): void => {
		if (shuttingDown) throw new Error("Pi worker domain client is shutting down");
	};

	const resolveProject = (cwd: string): string => {
		const absolute = resolve(cwd);
		const canonicalCwd = aliases.get(pathIdentity(absolute)) ?? absolute;
		const slot = projects.get(canonicalCwd);
		if (slot?.state !== "open") throw new Error(`Unknown open project: ${cwd}`);
		return slot.cwd;
	};

	const listOpenProjectPaths = (): string[] =>
		[...projects.values()].filter((slot) => slot.state === "open").map((slot) => slot.cwd);

	const withProject = <Result>(cwd: string, operation: (canonicalCwd: string) => Promise<Result>): Promise<Result> => {
		let canonicalCwd: string;
		try {
			assertAcceptingOperations();
			canonicalCwd = resolveProject(cwd);
		} catch (error) {
			return Promise.reject(error);
		}
		const slot = projects.get(canonicalCwd);
		if (slot?.state !== "open") return Promise.reject(new Error(`Unknown open project: ${cwd}`));
		const tracked: Promise<Result> = Promise.resolve()
			.then(() => {
				if (slot.state !== "open") throw new Error(`Project is closing: ${canonicalCwd}`);
				return operation(canonicalCwd);
			})
			.finally(() => slot.operations.delete(tracked));
		slot.operations.add(tracked);
		return tracked;
	};

	const waitForProjectOperations = async (slot: ProjectSlot): Promise<void> => {
		const pending = [...slot.operations];
		if (pending.length === 0) return;
		await Promise.allSettled(pending);
		await waitForProjectOperations(slot);
	};

	const client: PiWorkerDomainClient = {
		...createPiDomainWireClient(call),

		prepareShutdown() {
			if (shutdownPreparation) return shutdownPreparation;
			shuttingDown = true;
			shutdownPreparation = call("host.prepareShutdown", {});
			return shutdownPreparation;
		},
		async openProject(cwd) {
			assertAcceptingOperations();
			const known = aliases.get(pathIdentity(resolve(cwd)));
			if (known) {
				const existing = projects.get(known);
				if (existing?.state === "closing") await existing.closePromise;
			}
			const snapshot = await call("project.open", { cwd });
			let slot = projects.get(snapshot.cwd);
			if (!slot) {
				slot = { cwd: snapshot.cwd, state: "open", operations: new Set(), closePromise: null };
				projects.set(snapshot.cwd, slot);
			}
			slot.state = "open";
			rememberAlias(aliases, cwd, snapshot.cwd);
			return diagnosticsSnapshot(snapshot);
		},
		inspectProject(cwd) {
			return withProject(cwd, async (canonicalCwd) =>
				diagnosticsSnapshot(await call("project.inspect", { cwd: canonicalCwd })),
			);
		},
		projectPiConfig(cwd) {
			return withProject(cwd, (canonicalCwd) => call("project.piConfig", { cwd: canonicalCwd }));
		},
		closeProject(cwd, drain) {
			let canonicalCwd: string;
			try {
				canonicalCwd = resolveProject(cwd);
			} catch (error) {
				return Promise.reject(error);
			}
			const slot = projects.get(canonicalCwd);
			if (!slot) return Promise.reject(new Error(`Unknown open project: ${cwd}`));
			if (slot.closePromise) return slot.closePromise;
			slot.state = "closing";
			const tracked = (async () => {
				try {
					await waitForProjectOperations(slot);
					await drain(slot.cwd);
					await call("project.close", { cwd: slot.cwd });
					projects.delete(slot.cwd);
					for (const [identity, target] of aliases) {
						if (target === slot.cwd) aliases.delete(identity);
					}
				} catch (error) {
					slot.state = "open";
					throw error;
				}
			})();
			slot.closePromise = tracked;
			const clear = (): void => {
				if (slot.closePromise === tracked) slot.closePromise = null;
			};
			void tracked.then(clear, clear);
			return tracked;
		},
		listOpenProjectPaths,
		resolveProject,
		withProject,
		reloadProjectSettings: (projectCwds) =>
			call("project.reloadSettings", { projectCwds: [...(projectCwds ?? listOpenProjectPaths())] }),
		refreshSettingsSnapshots: () => call("project.refreshSettingsSnapshots", { projectCwds: listOpenProjectPaths() }),
		listSessions(cwd) {
			return withProject(cwd, (canonicalCwd) => call("session.list", { cwd: canonicalCwd }));
		},
		discoverSessions(cwd, cachedFiles) {
			return withProject(cwd, (canonicalCwd) =>
				call("session.discover", { cwd: canonicalCwd, cachedFiles: [...cachedFiles] }),
			);
		},

		readArchivedSession(cwd, sessionFilePath, markdownWidth) {
			return call("session.readArchived", { cwd, sessionFilePath, markdownWidth });
		},

		getModelConfiguration(request) {
			return request.cwd === null
				? call("model.getConfiguration", request)
				: withProject(request.cwd, (cwd) => call("model.getConfiguration", { ...request, cwd }));
		},

		listProjectModels(cwd) {
			return withProject(cwd, (canonicalCwd) => call("model.listProjectModels", { cwd: canonicalCwd }));
		},
		getApiKey(target) {
			return target.cwd === null
				? call("model.getApiKey", target)
				: withProject(target.cwd, (cwd) => call("model.getApiKey", { ...target, cwd }));
		},

		removeAuth(target) {
			return target.cwd === null
				? call("model.removeAuth", target)
				: withProject(target.cwd, (cwd) => call("model.removeAuth", { ...target, cwd }));
		},

		startLogin(flowId, provider, method, cwd, admissionSignal) {
			if (shuttingDown) return Promise.reject(new Error("Pi worker domain client is shutting down"));
			const start = async (canonicalCwd: string | null) => {
				// Project admission is deferred. A cancel RPC can otherwise overtake this start.
				admissionSignal?.throwIfAborted();
				// Once dispatched, ordered model.loginCancel owns SDK cancellation. Keep awaiting
				// the original result so terminal events and partially saved credentials can reconcile.
				return call("model.loginStart", { flowId, provider, method, cwd: canonicalCwd });
			};
			return cwd === null ? start(null) : withProject(cwd, start);
		},

		reconcileCredential(cwd) {
			return cwd === null
				? call("model.reconcileCredential", { cwd })
				: withProject(cwd, (canonicalCwd) => call("model.reconcileCredential", { cwd: canonicalCwd }));
		},
		onModelCatalogChanged(listener) {
			modelCatalogListeners.add(listener);
			return () => modelCatalogListeners.delete(listener);
		},
		onModelLoginEvent(listener) {
			modelLoginListeners.add(listener);
			return () => modelLoginListeners.delete(listener);
		},
		onModelOpenExternal(listener) {
			modelOpenExternalListeners.add(listener);
			return () => modelOpenExternalListeners.delete(listener);
		},

		readSkillsOverview: () => call("skills.overview", { projectCwds: listOpenProjectPaths() }),
		readProjectSkills(cwd) {
			return withProject(cwd, (canonicalCwd) => call("skills.project", { cwd: canonicalCwd }));
		},

		handleEvent(event): event is PiWorkerDomainEvent {
			if (
				event.kind !== "modelCatalogChanged" &&
				event.kind !== "modelLoginEvent" &&
				event.kind !== "modelOpenExternal"
			) {
				return false;
			}
			if (event.generation !== eventGeneration) {
				eventGeneration = event.generation;
				eventSequence = 0;
			}
			if (event.sequence <= eventSequence) return true;
			eventSequence = event.sequence;
			if (event.kind === "modelCatalogChanged") {
				notifyListeners([...modelCatalogListeners], "Pi model catalog");
			} else if (event.kind === "modelLoginEvent") {
				notifyListeners([...modelLoginListeners], "Pi model login", event.flowId, event.event);
			} else {
				notifyListeners([...modelOpenExternalListeners], "Pi model external URL", event.flowId, event.url);
			}
			return true;
		},
	};

	return client;
}
