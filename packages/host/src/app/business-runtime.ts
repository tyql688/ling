import type { HostShellEvent } from "@ling/contracts/host-shell";
import type { SessionRef } from "@ling/contracts/session-ref";
import { createProjectFileWatchers } from "@ling/host/domains/review/project-file-watcher";
import { createExtensionUiBridge } from "@ling/core/pi-protocol/extension-ui";
import { createLogger } from "@ling/core/logger";
import { createManagedSessionManager } from "@ling/host/domains/sessions/manager/session-manager";
import { createGitWriteQueue } from "@ling/host/domains/git/git-write-queue";
import { createPluginOperationRegistry } from "@ling/host/domains/plugins/operations";
import { createPluginMutationRunner } from "@ling/host/domains/plugins/plugin-mutation";
import { createPluginTool } from "@ling/host/domains/plugins/plugin-tool";
import { createMetadataCleanupHost } from "@ling/host/domains/projects/metadata-cleanup";
import { createProjectLifecycle } from "@ling/host/domains/projects/project-lifecycle";
import { createProjectMentionCache } from "@ling/host/domains/projects/project-mention-cache";
import { createProjectOperations } from "@ling/host/domains/projects/project-operation";
import { createProjectTrustHost } from "@ling/host/domains/projects/project-trust";
import { createResourceReloadCoordinator } from "@ling/host/domains/resources/resource-reload";
import { createChangeReviewHost } from "@ling/host/domains/review/change-review";
import { createChangeReviewOperationRegistry } from "@ling/host/domains/review/operations";
import { createComposerHistory } from "@ling/host/domains/sessions/composer-history";
import { createSessionCatalogStore } from "@ling/host/domains/sessions/session-catalog";
import { createSessionHost } from "@ling/host/domains/sessions/session-host";
import { createAppSettingsStore } from "@ling/host/domains/settings/app-settings";
import { importLoginShellEnv } from "@ling/host/domains/settings/shell-env";
import { createPiWorkerClient } from "@ling/host/workers/pi/pi-worker-client";
import { createPluginClient } from "@ling/host/workers/plugin/client";
import { createPluginHostTransport } from "@ling/host/workers/plugin/client-transport";
import { createPluginHostSpawner } from "@ling/host/workers/plugin/plugin-host-spawner";
import { createRuntimeLifetime } from "@ling/node-runtime/runtime-lifetime";
import { createMetadataCleanupRetryStore } from "../domains/projects/metadata-cleanup-retry-store";
import { createProjectStore } from "../domains/projects/project-store";
import { createChangeReviewStore } from "../domains/review/change-review-store";
import { createSessionTranscriptProjectionCache } from "../domains/sessions/session-transcript-projection-cache";
import { getHostRuntimePaths } from "../runtime/runtime-paths";
import type { DiagnosticsStore } from "../runtime/diagnostics-store";
import { createHostDatabase } from "../storage/database";
import { createHostClientState, type HostClientState } from "../transport/client-state";
import type { HostEventBus } from "../transport/event-bus";
import type { HostRequestRouter } from "../transport/request-router";
import { createHostShellActivity } from "../transport/shell-activity";
import type { HostMediaResponder } from "../transport/web-server";
import { createHostBusinessDomains } from "./business-handlers";
import { createHostMediaResponder } from "./media-service";
import { interactionProcedures } from "@ling/contracts/interaction-procedures";
import { questionsProcedures } from "@ling/contracts/questions-procedures";
import { backgroundTasksProcedures } from "@ling/contracts/background-tasks-procedures";
import { schedulesProcedures } from "@ling/contracts/schedules-procedures";
import { createInteractions } from "../domains/interactions/interactions";
import { createCompanionRuns } from "../domains/companions/companion-runs";
import { createCompanionToolDispatch } from "../domains/companions/tool-dispatch";
import { createQuestions } from "../domains/questions/questions";
import { createBackgroundTasks } from "../domains/background-tasks/background-tasks";
import { createSchedules } from "../domains/schedules/schedules";
import { createTodo } from "../domains/pi-adapters/todo/todo";
import { createAccessActivation } from "../domains/pi-adapters/permission-system/activation";
import { createPiAdapterPlan } from "../domains/pi-adapters/adapter-plan";
import { createBuiltinFeatures } from "../domains/companions/builtin-features";

const log = createLogger("host-runtime");

interface HostBusinessRuntimeOptions {
	router: HostRequestRouter;
	events: HostEventBus;
	appVersion: string;
	systemProxyFallback: string | null;
	diagnostics: DiagnosticsStore | null;
	onShellEvent?(event: HostShellEvent): void;
}

interface HostBusinessRuntime {
	clients: HostClientState;
	serveMedia: HostMediaResponder;
	disconnectClient(clientId: string): void;
	prepareShutdown(): void;
	dispose(): Promise<void>;
}

function snapshotProcessEnvironment(): Record<string, string> {
	const environment: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) environment[key] = value;
	}
	environment.LING_BUILTIN_SKILLS_DIR = getHostRuntimePaths().builtinSkillsDir;
	return environment;
}

export async function createHostBusinessRuntime(options: HostBusinessRuntimeOptions): Promise<HostBusinessRuntime> {
	const lifetime = createRuntimeLifetime([
		"mutations",
		"projects",
		"background",
		"handlers",
		"sessions",
		"managedSessions",
		"pi",
		"workers",
		"extensionUi",
		"stores",
		"database",
	] as const);
	try {
		await importLoginShellEnv();
		const hostEnvironment = snapshotProcessEnvironment();
		const database = createHostDatabase(getHostRuntimePaths().userDataDir);
		lifetime.defer("database", "Host database", database.dispose);
		const projectStore = createProjectStore({ userDataDir: getHostRuntimePaths().userDataDir, database });
		const pluginTransport = createPluginHostTransport(
			createPluginHostSpawner({
				hostEnvironment: () => hostEnvironment,
				systemProxyFallback: () => options.systemProxyFallback,
			}),
		);
		lifetime.defer("workers", "plugin host", pluginTransport.dispose);
		const catalog = createSessionCatalogStore({ userDataDir: getHostRuntimePaths().userDataDir, database });
		lifetime.defer("stores", "session catalog", catalog.dispose);
		const composerHistory = createComposerHistory({ userDataDir: getHostRuntimePaths().userDataDir, database });
		lifetime.defer("stores", "composer history", composerHistory.dispose);
		const mentionCache = createProjectMentionCache();
		lifetime.defer("background", "project mention cache", mentionCache.dispose);
		const gitWrites = createGitWriteQueue();
		lifetime.defer("stores", "Git write queue", gitWrites.dispose);
		const watchers = createProjectFileWatchers();
		lifetime.defer("projects", "project file watchers", watchers.dispose);
		const review = createChangeReviewHost({
			store: createChangeReviewStore({ userDataDir: getHostRuntimePaths().userDataDir, database }),
			withProject: (cwd, operation) => piWorker.withProject(cwd, operation),
			watchers,
			gitWrites,
		});
		lifetime.defer("stores", "change review", review.shutdownChangeReviewInfrastructure);
		const reviewOperations = createChangeReviewOperationRegistry();
		const metadataCleanup = createMetadataCleanupHost({
			retries: createMetadataCleanupRetryStore({ userDataDir: getHostRuntimePaths().userDataDir, database }),
			removeSessionFromCatalog: catalog.remove,
			deleteChangeReviewSessionState: review.deleteChangeReviewSessionState,
			releaseChangeReviewProject: review.releaseChangeReviewProject,
		});
		const settings = createAppSettingsStore({ userDataDir: getHostRuntimePaths().userDataDir, database });
		lifetime.defer("stores", "app settings", settings.dispose);
		lifetime.defer("stores", "metadata cleanup", metadataCleanup.shutdownMetadataCleanupRetries);
		const reviewReady = review.initializeChangeReviewInfrastructure().catch((error: unknown) => {
			log.error("failed to clean stale change review checkpoints; continuing with per-session cleanup:", error);
		});
		lifetime.defer("background", "startup review maintenance", () => reviewReady);
		const trustHost = createProjectTrustHost(options.router.handle, options.events);
		lifetime.onStop("project trust prompts", trustHost.dispose);
		const extensionUi = createExtensionUiBridge();
		lifetime.defer("extensionUi", "extension UI bridge", extensionUi.dispose);
		const piWorker = createPiWorkerClient({
			extensionUi,
			runPluginTool: (value, signal) => pluginTool.runPluginTool(value, signal),
			invokeCompanionTool: (call, signal) => invokeCompanionTool(call, signal),
			readAdapterPlan: (cwd) => adapterPlan.read(cwd),
			promptProjectTrust: trustHost.prompt,
			turnLifecycleHost: review.changeReviewTurnLifecycleHost,
			hostEnvironment: () => hostEnvironment,
			systemProxyFallback: () => options.systemProxyFallback,
		});
		lifetime.defer("pi", "Pi worker client", piWorker.dispose);
		const manager = createManagedSessionManager({
			runtimeProvider: piWorker,
			projectionCache: createSessionTranscriptProjectionCache({
				userDataDir: getHostRuntimePaths().userDataDir,
				appVersion: options.appVersion,
			}),
			extensionUi,
		});
		lifetime.onStop("managed session admission", manager.prepareShutdown);
		lifetime.defer("managedSessions", "managed sessions", manager.dispose);
		const projectOperations = createProjectOperations(piWorker);
		const resources = createResourceReloadCoordinator({
			reloadProjectSettings: piWorker.reloadProjectSettings,
			reloadSessionResources: manager.reloadSessionResources,
		});
		lifetime.defer("background", "resource reloads", resources.dispose);
		const pluginClient = createPluginClient({
			requestPluginHost: pluginTransport.requestPluginHost,
			projectPiConfig: piWorker.projectPiConfig,
		});
		const pluginOperations = createPluginOperationRegistry();
		lifetime.onStop("plugin mutation admission", pluginOperations.dispose);
		const pluginMutations = createPluginMutationRunner({
			projectPiConfig: piWorker.projectPiConfig,
			withKnownOpenProject: projectOperations.withKnownOpenProject,
			reloadPiResources: resources.reloadPiResources,
			pluginOperations,
		});
		lifetime.defer("mutations", "plugin mutation reconciliation", pluginMutations.dispose);
		const pluginTool = createPluginTool({
			client: pluginClient,
			mutations: pluginMutations,
			projects: projectOperations,
			requireManagedSession: manager.registry.requireManagedSession,
		});
		void piWorker.start().catch((error: unknown) => {
			log.error("failed to start Pi worker; the next session operation will retry:", error);
		});
		const clients = createHostClientState();
		const paths = getHostRuntimePaths();
		const activation = createAccessActivation(paths.dataHome);
		const features = createBuiltinFeatures(paths.dataHome);
		const adapterPlan = createPiAdapterPlan(activation, features);
		const interactions = createInteractions((requests) =>
			options.events.broadcast(interactionProcedures.onChanged.channel, requests),
		);
		lifetime.onStop("interactions", interactions.dispose);
		const shellActivity = createHostShellActivity({
			readPreferences: settings.getAppSettingsFast,
			clients,
			events: options.events,
			handle: options.router.handle,
			...(options.onShellEvent ? { onShellEvent: options.onShellEvent } : {}),
		});
		lifetime.defer("sessions", "shell activity", shellActivity.dispose);
		const sessions = createSessionHost({
			pendingInteractionRefs: interactions.refs,
			catalog,
			composerHistory,
			manager,
			extensionUi,
			events: options.events,
			clients,
			shellActivity,
			review,
			reviewOperations,
		});
		lifetime.onStop("session admission", sessions.prepareShutdown);
		lifetime.defer("sessions", "session host", sessions.dispose);
		const projects = createProjectLifecycle({
			projectStore,
			mentionCache,
			piWorker,
			sessions,
			runBoundedGitWriteAtRoot: gitWrites.runBoundedGitWriteAtRoot,
			metadataCleanup,
		});
		lifetime.onStop("project admission", projects.prepareShutdown);
		lifetime.defer("projects", "open projects", projects.closeAllProjectsForShutdown);
		const assertProject = async (cwd: string) => {
			await projectsRestored;
			await projectOperations.withKnownOpenProject(cwd, async () => undefined);
		};
		const notify = (ref: SessionRef, attention: boolean, title: string, body: string) =>
			shellActivity.notify(ref, attention ? "attentionNeeded" : "backgroundCompletion", title, body);
		const runs = createCompanionRuns({ assertProject, prepareSession: sessions.prepareCompanionSession });
		lifetime.defer("workers", "companion runs", runs.dispose);
		const questions = createQuestions({
			requireEnabled: () => features.requireEnabled("questions"),
			home: paths.dataHome,
			interactions,
			deliver: (ref, requestId, text) =>
				manager.registry.requireManagedSession(ref).session.deliverReply(requestId, text),
			onChanged: (ref) => options.events.broadcast(questionsProcedures.onChanged.channel, ref),
		});
		lifetime.onStop("questions", questions.dispose);
		const backgroundTasks = createBackgroundTasks({
			requireEnabled: () => features.requireEnabled("background-tasks"),
			home: paths.dataHome,
			assertProject,
			assertSession: (ref) => void manager.registry.requireManagedSession(ref),
			notify,
			onChanged: (ref) => options.events.broadcast(backgroundTasksProcedures.onChanged.channel, ref),
		});
		lifetime.defer("workers", "background tasks", backgroundTasks.dispose);
		const schedules = createSchedules({
			features,
			home: paths.dataHome,
			runs,
			interactions,
			listModels: async (cwd) => {
				await assertProject(cwd);
				const catalog = await piWorker.listProjectModels(cwd);
				if (catalog.configError) throw new Error(catalog.configError);
				return catalog.models.map(({ provider, id, name, reasoning }) => ({ provider, id, name, reasoning }));
			},
			notify,
			onChanged: () => options.events.broadcast(schedulesProcedures.onChanged.channel, null),
		});
		lifetime.defer("workers", "schedules", schedules.dispose);
		const todo = createTodo({
			requireEnabled: () => features.requireEnabled("todo"),
			requireSession: (ref) => manager.registry.requireManagedSession(ref).session,
			runs,
		});
		const invokeCompanionTool = createCompanionToolDispatch({
			...questions.tools,
			...backgroundTasks.tools,
			...schedules.tools,
		});
		// A feature whose state cannot be recovered reports it on use; it never blocks the rest of the Host.
		const featuresInitialized = Promise.allSettled([
			questions.initialize(),
			backgroundTasks.initialize(),
			schedules.initialize(),
		]).then((results) => {
			for (const result of results)
				if (result.status === "rejected") log.error("feature state recovery failed:", result.reason);
		});
		lifetime.defer("mutations", "feature state recovery", () => featuresInitialized);
		const projectsRestored = projects.runProjectMutation(projects.restoreOpenProjects);
		lifetime.defer("projects", "project restoration", () => projectsRestored);
		const metadataRetried = projectsRestored
			.then(() => metadataCleanup.retryPendingMetadataCleanup())
			.then(
				() => undefined,
				(error: unknown) => log.error("failed to retry pending metadata cleanup:", error),
			);
		// These tasks report their own failures, but must settle before their stores are released.
		lifetime.defer("background", "startup metadata reconciliation", () => metadataRetried);
		const handlers = await createHostBusinessDomains({
			features,
			diagnostics: options.diagnostics,
			interactions,
			questions,
			backgroundTasks,
			schedules,
			todo,
			activation,
			assertProject,
			database,
			mentionCache,
			review,
			reviewOperations,
			metadataCleanup,
			gitWrites,
			projectOperations,
			resources,
			pluginClient,
			pluginTransport,
			pluginOperations,
			pluginMutations,
			settings,
			handle: options.router.handle,
			events: options.events,
			clients,
			projectsRestored,
			projects,
			sessions,
			piWorker,
			shellActivity,
		});
		lifetime.onStop("business handlers", handlers.prepareShutdown);
		lifetime.defer("handlers", "business handlers", handlers.dispose);
		options.router.assertComplete();
		return {
			clients,
			disconnectClient(clientId) {
				clients.disconnect(clientId);
				void handlers.disconnectClient(clientId).catch((error) => log.error("editor client cleanup failed:", error));
			},
			serveMedia: createHostMediaResponder(projectsRestored, {
				projectOperations,
				readSessionImage: manager.commands.readSessionImage,
			}),
			prepareShutdown: lifetime.stop,
			dispose: lifetime.dispose,
		};
	} catch (error) {
		return lifetime.fail(error);
	}
}
