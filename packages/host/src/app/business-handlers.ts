import { agentProcedures } from "@ling/contracts/agent-procedures";
import { createProjectFileDomain } from "@ling/host/domains/files/project-files-handlers";
import { createGitDomain } from "@ling/host/domains/git/git-handlers";
import type { GitWriteQueue } from "@ling/host/domains/git/git-write-queue";
import { createModelDomain } from "@ling/host/domains/models/model-handlers";
import type { PluginOperationRegistry } from "@ling/host/domains/plugins/operations";
import { createPluginDomain } from "@ling/host/domains/plugins/plugin-handlers";
import type { PluginMutationRunner } from "@ling/host/domains/plugins/plugin-mutation";
import type { MetadataCleanupHost } from "@ling/host/domains/projects/metadata-cleanup";
import { createProjectDomain } from "@ling/host/domains/projects/project-handlers";
import type { ProjectLifecycle } from "@ling/host/domains/projects/project-lifecycle";
import type { ProjectMentionCache } from "@ling/host/domains/projects/project-mention-cache";
import type { ProjectAccess } from "@ling/host/runtime/project-access";
import type { ResourceReloadCoordinator } from "@ling/host/domains/resources/resource-reload";
import type { ChangeReviewHost } from "@ling/host/domains/review/change-review";
import type { ChangeReviewOperationRegistry } from "@ling/host/domains/review/operations";
import { createChangeReviewDomain } from "@ling/host/domains/review/review-handlers";
import { createSessionDomain } from "@ling/host/domains/sessions/session-handlers";
import type { SessionHost } from "@ling/host/domains/sessions/session-host";
import { createGlobalInstructionsDomain } from "@ling/host/domains/settings/global-instructions-handlers";
import { createPiSettingsDomain } from "@ling/host/domains/settings/pi-network-settings-handlers";
import { createSkillDomain } from "@ling/host/domains/skills/skill-handlers";
import { createSkinDomain } from "@ling/host/domains/skins/skin-handlers";
import { createTerminalDomain } from "@ling/host/domains/terminal/terminal-handlers";
import { createUsageDomain } from "@ling/host/domains/usage/usage-handlers";
import type { PiWorkerClient } from "@ling/host/workers/pi/pi-worker-client";
import type { PluginClient } from "@ling/host/workers/plugin/client";
import type { PluginHostClientTransport } from "@ling/host/workers/plugin/client-transport";
import { createDataDomain } from "../domains/data/data-handlers";
import { createDataSources } from "./data-sources";
import { createUserStateDomain } from "../domains/data/user-state-handlers";
import { createDraftDomain } from "../domains/data/draft-handlers";
import type { AppSettingsStore } from "../domains/settings/app-settings";
import { createAppSettingsDomain } from "../domains/settings/app-settings-handlers";
import type { HostDatabase } from "../storage/database";
import type { HostClientState } from "../transport/client-state";
import type { HostEventPublisher } from "../transport/event-bus";
import type { HostHandle } from "../transport/request-router";
import type { HostShellActivity } from "../transport/shell-activity";
import { createHostDomainRuntime } from "./domain-runtime";
import { createInteractionDomain } from "../domains/interactions/interaction-handlers";
import type { Interactions } from "../domains/interactions/interactions";
import { createQuestionDomain } from "../domains/questions/question-handlers";
import type { Questions } from "../domains/questions/questions";
import { createBackgroundTaskDomain } from "../domains/background-tasks/background-task-handlers";
import type { BackgroundTasks } from "../domains/background-tasks/background-tasks";
import { createScheduleDomain } from "../domains/schedules/schedule-handlers";
import type { Schedules } from "../domains/schedules/schedules";
import { createTodoDomain } from "../domains/pi-adapters/todo/todo-handlers";
import type { Todo } from "../domains/pi-adapters/todo/todo";
import { createPermissionDomain } from "../domains/pi-adapters/permission-system/permission-handlers";
import type { AccessActivationStore } from "../domains/pi-adapters/permission-system/activation";
import { permissionsProcedures } from "@ling/contracts/permissions-procedures";
import { createEditorLanguageDomain } from "../domains/editor/editor-handlers";
import { createDiagnosticsDomain } from "../domains/diagnostics/diagnostics-handlers";
import type { DiagnosticsStore } from "../runtime/diagnostics-store";
import type { BuiltinFeatureStore } from "../domains/companions/builtin-features";
import { createBuiltinFeatureDomain } from "../domains/companions/builtin-feature-handlers";
import { builtinFeaturesProcedures } from "@ling/contracts/builtin-feature-procedures";

export interface HostBusinessHandlersOptions {
	features: BuiltinFeatureStore;
	diagnostics: DiagnosticsStore | null;
	interactions: Interactions;
	questions: Questions;
	backgroundTasks: BackgroundTasks;
	schedules: Schedules;
	todo: Todo;
	activation: AccessActivationStore;
	assertProject(cwd: string): Promise<void>;
	database: HostDatabase;
	mentionCache: ProjectMentionCache;
	review: ChangeReviewHost;
	reviewOperations: ChangeReviewOperationRegistry;
	metadataCleanup: MetadataCleanupHost;
	gitWrites: GitWriteQueue;
	settings: AppSettingsStore;
	handle: HostHandle;
	events: HostEventPublisher;
	clients: HostClientState;
	projectsRestored: Promise<void>;
	projects: ProjectLifecycle;
	sessions: SessionHost;
	piWorker: PiWorkerClient;
	projectOperations: ProjectAccess;
	resources: ResourceReloadCoordinator;
	pluginClient: PluginClient;
	pluginTransport: PluginHostClientTransport;
	pluginOperations: PluginOperationRegistry;
	pluginMutations: PluginMutationRunner;
	shellActivity: HostShellActivity;
}

interface HostBusinessHandlers {
	disconnectClient(clientId: string): Promise<void>;
	prepareShutdown(): void;
	dispose(): Promise<void>;
}

export async function createHostBusinessDomains(options: HostBusinessHandlersOptions): Promise<HostBusinessHandlers> {
	const domains = createHostDomainRuntime(options.handle);
	try {
		const { piWorker, resources, projectOperations, gitWrites, events, projectsRestored, projects, settings } = options;
		domains.add("built-in features", "handlers", () =>
			createBuiltinFeatureDomain({
				features: options.features,
				resources,
				onChanged: () => events.broadcast(builtinFeaturesProcedures.onChanged.channel, null),
			}),
		);
		domains.add("interactions", "handlers", () => createInteractionDomain(options.interactions));
		domains.add("questions", "handlers", () => createQuestionDomain(options.questions));
		domains.add("background tasks", "handlers", () => createBackgroundTaskDomain(options.backgroundTasks));
		domains.add("schedules", "handlers", () => createScheduleDomain(options.schedules));
		domains.add("todo", "handlers", () => createTodoDomain(options.todo));
		domains.add("permissions", "handlers", () =>
			createPermissionDomain({
				activation: options.activation,
				resources,
				assertProject: options.assertProject,
				listOpenProjectPaths: piWorker.listOpenProjectPaths,
				onChanged: () => {
					void options.activation.read().then(
						(value) => events.broadcast(permissionsProcedures.onChanged.channel, value),
						() => undefined,
					);
				},
			}),
		);
		domains.add("diagnostics", "handlers", () =>
			createDiagnosticsDomain({ store: options.diagnostics, listProcesses: piWorker.listProcesses }),
		);
		domains.add("data health", "handlers", () =>
			createDataDomain({ database: options.database, events, ...createDataSources(options) }),
		);
		domains.add("user state", "handlers", () => createUserStateDomain({ database: options.database, events }));
		domains.add("drafts", "handlers", () => createDraftDomain({ database: options.database, events }));
		domains.add("app settings", "handlers", () =>
			createAppSettingsDomain({ settingsStore: settings, onChanged: options.shellActivity.refreshPreferences }),
		);
		domains.add("Pi settings", "handlers", () => createPiSettingsDomain({ piWorker, resources, events }));
		domains.add("global instructions", "handlers", () => createGlobalInstructionsDomain({ piWorker }));
		domains.add("models", "handlers", () => createModelDomain({ piWorker, resources, projectOperations, events }));
		const terminals = domains.add("terminal host", "workers", () =>
			createTerminalDomain({ projectOperations, events, projectsRestored, settings }),
		);
		const editor = domains.add("editor language services", "workers", () =>
			createEditorLanguageDomain({
				projectOperations,
				projectsRestored,
				events,
				isTrusted: async (cwd) => (await piWorker.projectPiConfig(cwd)).trusted,
			}),
		);
		domains.add("usage host", "workers", () => createUsageDomain({ piWorker }));
		const closeProjectTerminals = async ({ cwd }: { cwd: string }) => {
			const results = await Promise.allSettled([terminals.closeProject(cwd), editor.closeProject(cwd)]);
			const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
			if (failures.length) throw new AggregateError(failures, "Project tools could not all close");
		};
		domains.add("Git", "handlers", () =>
			createGitDomain({
				projectOperations,
				gitWrites,
				projectsRestored,
				projects,
				afterProjectRuntimeClose: closeProjectTerminals,
			}),
		);
		domains.add("sessions", "handlers", () =>
			createSessionDomain({
				clients: options.clients,
				events,
				projectsRestored,
				sessions: options.sessions,
				readArchivedSession: piWorker.readArchivedSession,
				listOpenProjectPaths: piWorker.listOpenProjectPaths,
				metadataCleanup: options.metadataCleanup,
			}),
		);
		domains.add("projects", "handlers", () =>
			createProjectDomain({
				piWorker,
				resources,
				projectOperations,
				events,
				projectsRestored,
				projects,
				settings,
				mentionCache: options.mentionCache,
				afterRuntimeClose: closeProjectTerminals,
			}),
		);
		domains.add("project files", "handlers", () => createProjectFileDomain({ projectOperations, projectsRestored }));
		domains.add("agent info", "handlers", () => ({
			handlers: { [agentProcedures.getInfo.channel]: async () => piWorker.getAgentInfo() },
		}));
		domains.add("change review", "handlers", () =>
			createChangeReviewDomain({
				review: options.review,
				changeReviewDiffOperations: options.reviewOperations,
				openProjectPaths: piWorker.listOpenProjectPaths,
			}),
		);
		domains.add("plugins", "handlers", () =>
			createPluginDomain({
				client: options.pluginClient,
				mutations: options.pluginMutations,
				operations: options.pluginOperations,
				transport: options.pluginTransport,
				resources,
				projects: projectOperations,
				events,
			}),
		);
		domains.add("skills", "handlers", () =>
			createSkillDomain({ piWorker, resources, projectOperations, projectsRestored }),
		);
		domains.add("skins", "workers", () => createSkinDomain({ events }));
		return {
			prepareShutdown: domains.prepareShutdown,
			dispose: domains.dispose,
			disconnectClient: editor.releaseClient,
		};
	} catch (error) {
		return domains.fail(error);
	}
}
