import type { ModelLoginEvent } from "@ling/contracts/model";
import { probeOpenAiCompatibleEndpoint } from "@ling/core/pi-sdk/models/endpoint-probe";
import { throwAggregateFailures } from "@ling/core/ling-error";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { piDomainMethods } from "../../pi-protocol/domain-methods";
import { dispatchPiMethod, type PiMethodHandlers } from "../../pi-protocol/method";
import type {
	PiWorkerEvent,
	PiWorkerRequest,
	PiWorkerSessionDiscovery,
	PiWorkerSessionInfo,
} from "../../pi-protocol/protocol";
import { parsePiWorkerAbsolutePath } from "../../pi-protocol/protocol-validation";
import { PI_WORKER_PROTOCOL_VERSION } from "../../pi-protocol/wire-format";
import { getAgentInfo } from "../agent-info";
import { collectServiceDiagnostics } from "../diagnostics";
import type { PiModelCatalog } from "../models/model-catalog";
import type { PiModelConfiguration } from "../models/model-configuration";
import type { PiModels } from "../models/models";
import type { PiProviderQuotas } from "../models/provider-quotas";
import type { PiProjectServices } from "../projects/services";
import {
	listPiSkillResources,
	readPiSkillContent,
	readPiSkillResource,
	resolvePiSkillResourcePath,
	type PiSkillCatalog,
} from "../resources/skills";
import { readArchivedPiSessionMessages } from "../session/session-archive";
import { discoverPiSessions, listPiSessions } from "../session/session-discovery";
import type { PiSettings } from "../settings/settings";
import type { PiWorkerRuntimeService } from "./pi-worker-runtime-service";

interface PiWorkerDomainService {
	handle(request: PiWorkerRequest, signal: AbortSignal): Promise<unknown>;
	dispose(): Promise<void>;
}

interface PiWorkerDomainServiceOptions {
	settings: PiSettings;
	projects: PiProjectServices;
	models: PiModels;
	catalog: PiModelCatalog;
	configuration: PiModelConfiguration;
	quotas: PiProviderQuotas;
	skills: PiSkillCatalog;
	generation: number;
	runtimeService: PiWorkerRuntimeService;
	emit(event: PiWorkerEvent): void;
}

function toSessionInfo(
	info: Awaited<ReturnType<typeof listPiSessions>>[number] & { manualFork?: boolean },
): PiWorkerSessionInfo {
	return {
		path: info.path,
		id: info.id,
		cwd: info.cwd,
		...(info.name === undefined ? {} : { name: info.name }),
		...(info.parentSessionPath === undefined ? {} : { parentSessionPath: info.parentSessionPath }),
		...(info.manualFork === undefined ? {} : { manualFork: info.manualFork }),
		createdAt: info.created.getTime(),
		modifiedAt: info.modified.getTime(),
		messageCount: info.messageCount,
		firstMessage: info.firstMessage,
	};
}

function toSessionDiscovery(
	discovery: Awaited<ReturnType<typeof discoverPiSessions>>[number],
): PiWorkerSessionDiscovery {
	if (discovery.kind === "cached") return discovery;
	return { ...discovery, info: toSessionInfo(discovery.info) };
}

export function createPiWorkerDomainService(options: PiWorkerDomainServiceOptions): PiWorkerDomainService {
	const {
		closeProject,
		getPiServices,
		listOpenProjectPaths,
		onPiModelCatalogChanged,
		openProject,
		reloadProjectSettings,
		reloadOpenProjectSettingsSnapshots,
		withOpenProject,
	} = options.projects;
	const {
		addCustomModel,
		addCustomProvider,
		cancelLogin,
		cancelModelCatalogRefresh,
		listProviders,
		reconcileProviderCredentialRuntime,
		refreshModelCatalogs,
		removeCustomModel,
		removeCustomProvider,
		removeProjectProviderAuth,
		removeProviderAuth,
		respondLogin,
		setProviderApiKey,
		shutdownModelOperations,
		startLogin,
		updateCustomModel,
		updateCustomProvider,
	} = options.models;
	const { getProjectProviderApiKey, getProviderApiKey, listProjectModels } = options.catalog;
	const { getModelConfiguration } = options.configuration;
	const { readPiProjectSkills, readPiSkillsOverview, setSkillEnabled } = options.skills;

	const { getHttpProxySetting, initHttpProxy, setHttpProxySetting } = options.settings.network;
	const { getPiSettings, getPiSettingsRecoveryStatus, repairPiHttpIdleTimeout, updatePiSettings } = options.settings;
	const { shutdownGlobalSettingsMutations } = options.settings.mutations;
	const { addGlobalSkillPath, removeGlobalSkillPath, setBuiltinSkillsEnabled } = options.skills;

	let eventSequence = 0;
	let disposed = false;
	let operationShutdownPromise: Promise<void> | null = null;
	const loginStarts = new Map<string, { cancelled: boolean }>();

	const emit = (
		event:
			| Omit<Extract<PiWorkerEvent, { kind: "modelCatalogChanged" }>, "protocolVersion" | "generation" | "sequence">
			| Omit<Extract<PiWorkerEvent, { kind: "modelLoginEvent" }>, "protocolVersion" | "generation" | "sequence">
			| Omit<Extract<PiWorkerEvent, { kind: "modelOpenExternal" }>, "protocolVersion" | "generation" | "sequence">,
	): void => {
		eventSequence += 1;
		options.emit({
			...event,
			protocolVersion: PI_WORKER_PROTOCOL_VERSION,
			generation: options.generation,
			sequence: eventSequence,
		});
	};

	const ensureProject = async (cwd: string): Promise<string> => {
		if (listOpenProjectPaths().includes(cwd)) return getPiServices(cwd).cwd;
		return (await openProject(cwd)).cwd;
	};
	const releaseModelCatalogChanged = onPiModelCatalogChanged(() => emit({ kind: "modelCatalogChanged" }));
	const shutdownOperations = (): Promise<void> => {
		if (operationShutdownPromise) return operationShutdownPromise;
		operationShutdownPromise = (async () => {
			const results = await Promise.allSettled([shutdownModelOperations(), shutdownGlobalSettingsMutations()]);
			throwAggregateFailures(
				results.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
				"Failed to stop Pi worker domain operations",
			);
		})();
		return operationShutdownPromise;
	};

	const ensureProjects = async (cwdValues: string[]): Promise<string[]> => {
		const paths = cwdValues.map(parsePiWorkerAbsolutePath);
		return Promise.all(paths.map(ensureProject));
	};

	const handlers: PiMethodHandlers<typeof piDomainMethods, AbortSignal> = {
		"agent.getInfo": async () => {
			return getAgentInfo();
		},
		"host.prepareShutdown": async () => {
			await shutdownOperations();
			return null;
		},
		"project.open": async (input) => {
			const params = input;
			const cwd = await ensureProject(parsePiWorkerAbsolutePath(params.cwd));
			return withOpenProject(cwd, async (services) => ({
				cwd: services.cwd,
				diagnostics: collectServiceDiagnostics(services),
			}));
		},
		"project.inspect": async (input) => {
			const params = input;
			const cwd = await ensureProject(parsePiWorkerAbsolutePath(params.cwd));
			return withOpenProject(cwd, async (services) => ({
				cwd: services.cwd,
				diagnostics: collectServiceDiagnostics(services),
			}));
		},
		"project.piConfig": async (input) => {
			const params = input;
			const cwd = await ensureProject(parsePiWorkerAbsolutePath(params.cwd));
			return withOpenProject(cwd, async (services) => {
				const path = join(services.cwd, ".pi", "settings.json");
				// Pi returns an empty object for an untrusted project and for a missing file
				// alike; the caller needs both facts to explain an empty panel.
				const exists = await stat(path).then(
					(entry) => entry.isFile(),
					(error: unknown) => {
						// Only a missing file is a valid empty project configuration.
						if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false;
						throw error;
					},
				);
				return {
					path,
					exists,
					trusted: services.settingsManager.isProjectTrusted(),
					settings: services.settingsManager.getProjectSettings() as Record<string, unknown>,
				};
			});
		},
		"project.close": async (input) => {
			const params = input;
			const cwd = parsePiWorkerAbsolutePath(params.cwd);
			if (!listOpenProjectPaths().includes(cwd)) return null;
			await closeProject(cwd, (closingCwd) => options.runtimeService.disposeProjectRuntimes(closingCwd));
			return null;
		},
		"project.reloadSettings": async (input) => {
			const params = input;
			await ensureProjects(params.projectCwds);
			initHttpProxy();
			await reloadProjectSettings(params.projectCwds);
			return null;
		},
		"project.refreshSettingsSnapshots": async (input) => {
			const params = input;
			await ensureProjects(params.projectCwds);
			initHttpProxy();
			await reloadOpenProjectSettingsSnapshots();
			await options.runtimeService.refreshSettings();
			return null;
		},
		"session.list": async (input) => {
			const params = input;
			const cwd = await ensureProject(parsePiWorkerAbsolutePath(params.cwd));
			return (await listPiSessions(cwd)).map(toSessionInfo);
		},
		"session.discover": async (input) => {
			const params = input;
			const cwd = await ensureProject(parsePiWorkerAbsolutePath(params.cwd));
			return (await discoverPiSessions(cwd, params.cachedFiles)).map(toSessionDiscovery);
		},
		"session.readArchived": async (input) => {
			const params = input;
			// No project is opened: the file is read straight from disk so a deleted project keeps
			// its history readable. `cwd` only scopes the request to a project Ling already knows.
			return readArchivedPiSessionMessages(parsePiWorkerAbsolutePath(params.sessionFilePath), params.markdownWidth);
		},
		"model.listProviders": async () => {
			return listProviders();
		},
		"model.getConfiguration": async (input) => {
			const params = input;
			return getModelConfiguration({
				...params,
				cwd: params.cwd === null ? null : await ensureProject(parsePiWorkerAbsolutePath(params.cwd)),
			});
		},
		"model.getProviderQuotas": async (_input, signal) => {
			return options.quotas.getProviderQuotaSnapshot(signal);
		},
		"model.listProjectModels": async (input) => {
			const params = input;
			return listProjectModels(await ensureProject(parsePiWorkerAbsolutePath(params.cwd)));
		},
		"model.getApiKey": async (input) => {
			const params = input;
			return params.cwd === null
				? getProviderApiKey(params.provider)
				: getProjectProviderApiKey(await ensureProject(parsePiWorkerAbsolutePath(params.cwd)), params.provider);
		},
		"model.setApiKey": async (input) => {
			const params = input;
			await setProviderApiKey(params.provider, params.key);
			return null;
		},
		"model.removeAuth": async (input) => {
			const params = input;
			if (params.cwd === null) await removeProviderAuth(params.provider);
			else await removeProjectProviderAuth(await ensureProject(parsePiWorkerAbsolutePath(params.cwd)), params.provider);
			return null;
		},
		"model.addProvider": async (input) => {
			await addCustomProvider(input);
			return null;
		},
		"model.addModel": async (input) => {
			await addCustomModel(input);
			return null;
		},
		"model.removeModel": async (input) => {
			const params = input;
			await removeCustomModel(params.provider, params.modelId);
			return null;
		},
		"model.removeProvider": async (input) => {
			const params = input;
			await removeCustomProvider(params.provider);
			return null;
		},
		"model.probeProvider": async (input) => {
			const params = input;
			return probeOpenAiCompatibleEndpoint(params.baseUrl, params.apiKey);
		},
		"model.updateProvider": async (input) => {
			await updateCustomProvider(input);
			return null;
		},
		"model.updateModel": async (input) => {
			await updateCustomModel(input);
			return null;
		},
		"model.refreshCatalogs": async (_input, signal) => {
			return refreshModelCatalogs(signal);
		},
		"model.cancelCatalogRefresh": async () => {
			cancelModelCatalogRefresh();
			return null;
		},
		"model.loginStart": async (input, signal) => {
			const params = input;
			if (loginStarts.has(params.flowId)) throw new Error("The model login is already starting");
			const start = { cancelled: false };
			loginStarts.set(params.flowId, start);
			try {
				const cwd = params.cwd === null ? null : await ensureProject(parsePiWorkerAbsolutePath(params.cwd));
				const onAbort = (): void => cancelLogin(params.flowId);
				signal.addEventListener("abort", onAbort, { once: true });
				try {
					if (signal.aborted) throw signal.reason;
					const login = startLogin(
						params.flowId,
						params.provider,
						params.method,
						cwd,
						(event: ModelLoginEvent) => emit({ kind: "modelLoginEvent", flowId: params.flowId, event }),
						(url) => emit({ kind: "modelOpenExternal", flowId: params.flowId, url }),
					);
					if (start.cancelled) cancelLogin(params.flowId);
					await login;
				} finally {
					signal.removeEventListener("abort", onAbort);
				}
			} finally {
				if (loginStarts.get(params.flowId) === start) loginStarts.delete(params.flowId);
			}
			return null;
		},
		"model.loginRespond": async (input) => {
			const params = input;
			respondLogin(params.flowId, params.requestId, params.value);
			return null;
		},
		"model.loginCancel": async (input) => {
			const params = input;
			const start = loginStarts.get(params.flowId);
			if (start) start.cancelled = true;
			cancelLogin(params.flowId);
			return null;
		},
		"model.reconcileCredential": async (input) => {
			const params = input;
			await reconcileProviderCredentialRuntime(
				params.cwd === null ? null : await ensureProject(parsePiWorkerAbsolutePath(params.cwd)),
			);
			return null;
		},
		"settings.getProxy": async () => {
			return getHttpProxySetting();
		},
		"settings.setProxy": async (input) => {
			const params = input;
			await setHttpProxySetting(params.proxy);
			return null;
		},
		"settings.get": async () => {
			return getPiSettings();
		},
		"settings.getRecoveryStatus": async () => {
			return getPiSettingsRecoveryStatus();
		},
		"settings.repairHttpIdleTimeout": async () => {
			await repairPiHttpIdleTimeout();
			return null;
		},
		"settings.update": async (input) => {
			const params = input;
			await updatePiSettings(params.update);
			return null;
		},
		"skills.overview": async (input) => {
			const params = input;
			await ensureProjects(params.projectCwds);
			return readPiSkillsOverview();
		},
		"skills.project": async (input) => {
			const params = input;
			return readPiProjectSkills(await ensureProject(parsePiWorkerAbsolutePath(params.cwd)));
		},
		"skills.addGlobalPath": async (input) => {
			const params = input;
			await addGlobalSkillPath(params.path);
			return null;
		},
		"skills.removeGlobalPath": async (input) => {
			const params = input;
			await removeGlobalSkillPath(params.path);
			return null;
		},
		"skills.setBuiltinEnabled": async (input) => {
			const params = input;
			await setBuiltinSkillsEnabled(params.enabled);
			return null;
		},
		"skills.setSkillEnabled": async (input) => {
			const params = input;
			await setSkillEnabled(params.name, params.enabled);
			return null;
		},
		"skills.readContent": async (input) => {
			const params = input;
			return readPiSkillContent(params.filePath);
		},
		"skills.listResources": async (input) => {
			const params = input;
			return listPiSkillResources(params.filePath);
		},
		"skills.readResource": async (input) => {
			const params = input;
			return readPiSkillResource(params.filePath, params.relativePath);
		},
		"skills.resolveResourcePath": async (input) => {
			const params = input;
			return resolvePiSkillResourcePath(params.filePath, params.relativePath);
		},
	};

	const handle = async (request: PiWorkerRequest, signal: AbortSignal): Promise<unknown> => {
		if (disposed) throw new Error("Pi worker domain service is shutting down");
		if (signal.aborted) throw signal.reason;
		if (!Object.hasOwn(piDomainMethods, request.method))
			throw new Error(`Pi domain service received a runtime method: ${request.method}`);
		return dispatchPiMethod(
			piDomainMethods,
			handlers,
			request.method as keyof typeof piDomainMethods,
			request.params,
			signal,
		);
	};

	return {
		handle,
		async dispose() {
			if (disposed) return;
			disposed = true;
			releaseModelCatalogChanged();
			const operationResults = await Promise.allSettled([shutdownOperations()]);
			const projectResults = await Promise.allSettled([
				options.projects.dispose(options.runtimeService.disposeProjectRuntimes),
			]);
			throwAggregateFailures(
				[...operationResults, ...projectResults].flatMap((result) =>
					result.status === "rejected" ? [result.reason] : [],
				),
				"Failed to dispose Pi worker domain services",
			);
		},
	};
}
