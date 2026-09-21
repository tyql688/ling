import {
	PROJECT_LIST_FAILURE_MESSAGE_MAX_CHARS,
	type OpenProjectInfo,
	type ProjectLaunchTarget,
	type ProjectListFailure,
	type ProjectListResult,
	type ProjectMentionItem,
	type ProjectRemovalOutcome,
	type ProjectStoreStatus,
} from "@ling/contracts/project";
import { projectProcedures } from "@ling/contracts/project-procedures";
import { toError } from "@ling/core/ling-error";
import { createLogger } from "@ling/core/logger";
import type { PiWorkerProjectPiConfig } from "@ling/core/pi-protocol/protocol";
import { createProjectLauncher } from "@ling/host/domains/projects/project-launcher";
import { assertKnownWorkspaceRoot } from "@ling/host/domains/projects/workspace-paths";
import type { ResourceReloadCoordinator } from "@ling/host/domains/resources/resource-reload";
import type { AppSettingsStore } from "@ling/host/domains/settings/app-settings";
import type { ProjectAccess } from "@ling/host/runtime/project-access";
import { DatasetReadError, datasetStoreStatusFromError } from "@ling/host/storage/dataset-envelope";
import type { HostEventPublisher } from "@ling/host/transport/event-bus";
import type { PiWorkerClient } from "@ling/host/workers/pi/pi-worker-client";
import type { HostDomain, HostHandlers } from "../../transport/host-domain";
import type { ProjectLifecycle, RemoveProjectOptions } from "./project-lifecycle";
import { filterMentionFiles, type ProjectMentionCache } from "./project-mention-cache";

const log = createLogger("project-ipc");

export function createProjectDomain({
	piWorker,
	resources,
	projectOperations,
	events,
	projectsRestored,
	projects,
	settings,
	mentionCache,
	afterRuntimeClose,
}: {
	piWorker: PiWorkerClient;
	resources: ResourceReloadCoordinator;
	projectOperations: ProjectAccess;
	events: HostEventPublisher;
	projectsRestored: Promise<void>;
	projects: ProjectLifecycle;
	settings: AppSettingsStore;
	mentionCache: ProjectMentionCache;
	afterRuntimeClose?: RemoveProjectOptions["afterRuntimeClose"];
}): HostDomain {
	const { cachedMentionFiles } = mentionCache;
	const { withKnownOpenProject } = projectOperations;
	const { onPiResourcesReloaded } = resources;

	const {
		recovery,
		toProjectInfo,
		projectRestorationFailures,
		runProjectMutation,
		restoreOpenProjects,
		persistOpenProjects,
		recoverOpenProjectsFromBackup,
		openProjectAndPersist,
		removeProjectAndPersist,
	} = projects;
	const projectLauncher = createProjectLauncher();
	/** Every connected client refetches the list; a mutation may change it even when it fails partway. */
	const publishChanged = (): void => events.broadcast(projectProcedures.onChanged.channel, null);
	/** Runs a project list mutation and tells every client to refetch afterwards. */
	const mutateList = async <Result>(mutation: () => Promise<Result>): Promise<Result> => {
		try {
			return await mutation();
		} finally {
			publishChanged();
		}
	};
	// A resource reload rebuilds each project's catalog and diagnostics inside the Pi worker.
	const unsubscribeReload = onPiResourcesReloaded(publishChanged);
	const handlers: HostHandlers = {
		[projectProcedures.list.channel]: async (): Promise<ProjectListResult> => {
			await projectsRestored;
			const issue = recovery.getIssue();
			if (issue?.kind === "read") {
				throw new Error("Ling could not read the project store", { cause: issue.error });
			}
			const paths = piWorker.listOpenProjectPaths();
			const inspected = await Promise.all(
				paths.map(async (cwd) => {
					try {
						return { status: "ready" as const, project: await toProjectInfo(cwd) };
					} catch (error) {
						const failure = toError(error);
						log.error(`failed to inspect open project ${cwd}:`, failure);
						return {
							status: "failed" as const,
							failure: {
								cwd,
								message: failure.message.slice(0, PROJECT_LIST_FAILURE_MESSAGE_MAX_CHARS),
							} satisfies ProjectListFailure,
						};
					}
				}),
			);
			const projects = inspected.flatMap((entry) => (entry.status === "ready" ? [entry.project] : []));
			const failures = [
				...projectRestorationFailures(),
				...inspected.flatMap((entry) => (entry.status === "failed" ? [entry.failure] : [])),
			];
			const firstFailure = failures[0];
			if (firstFailure === undefined) return { status: "complete", projects };
			return { status: "partial", projects, failureCount: failures.length, firstFailure };
		},

		[projectProcedures.storeStatus.channel]: async (_event): Promise<ProjectStoreStatus> => {
			await projectsRestored;
			const issue = recovery.getIssue();
			if (!issue) return { status: "ready" };
			if (issue.kind === "write") return { status: "degraded", errorCode: "PROJECT_STORE_WRITE_FAILED" };
			return datasetStoreStatusFromError(issue.error);
		},

		[projectProcedures.retryStore.channel]: async (_event): Promise<void> => {
			await projectsRestored;
			const issue = recovery.getIssue();
			if (!issue || issue.kind === "read") {
				await mutateList(() => runProjectMutation(() => restoreOpenProjects()));
				return;
			}
			try {
				await runProjectMutation(() => persistOpenProjects());
				recovery.clear();
			} catch (error) {
				recovery.recordWriteError(error);
				log.error("failed to retry persisting restored projects:", error);
			}
		},

		[projectProcedures.resetStore.channel]: async (_event): Promise<void> => {
			await projectsRestored;
			const issue = recovery.getIssue();
			if (issue?.kind !== "read" || !(issue.error instanceof DatasetReadError)) {
				if (issue) throw new Error("Project store recovery is temporarily unavailable", { cause: issue.error });
				throw new Error("Project store recovery is not required");
			}
			try {
				await mutateList(() => runProjectMutation(recoverOpenProjectsFromBackup));
			} catch (error) {
				log.error("failed to rebuild the project store:", error);
				throw new Error("Ling could not rebuild the project store", { cause: error });
			}
			recovery.clear();
		},

		[projectProcedures.add.channel]: async (_event, value): Promise<OpenProjectInfo> => {
			await projectsRestored;
			recovery.assertWritable();
			return mutateList(() => openProjectAndPersist(value));
		},

		[projectProcedures.listFiles.channel]: async (_event, value): Promise<ProjectMentionItem[]> => {
			return withKnownOpenProject(value.cwd, async (canonicalCwd) => {
				// Per-keystroke path: the fast getter avoids a synchronous disk read + validation here.
				const files = await cachedMentionFiles(
					canonicalCwd,
					settings.getAppSettingsFast().fileMentionsRespectGitignore,
				);
				return filterMentionFiles(files, value.query);
			});
		},

		[projectProcedures.piConfig.channel]: async (_event, value): Promise<PiWorkerProjectPiConfig> => {
			// Same gate as Remove: only a workspace root the host already tracks may be inspected,
			// so a renderer cannot read an arbitrary directory's settings through this channel.
			assertKnownWorkspaceRoot(value, piWorker.listOpenProjectPaths());
			return piWorker.projectPiConfig(value);
		},

		[projectProcedures.listLaunchTargets.channel]: async (_event): Promise<ProjectLaunchTarget[]> => {
			return projectLauncher.listTargets();
		},

		[projectProcedures.launch.channel]: async (_event, value): Promise<void> => {
			await withKnownOpenProject(value.cwd, async (canonicalCwd) => {
				await projectLauncher.launch(canonicalCwd, value.targetId);
			});
		},

		[projectProcedures.launchDefault.channel]: async (_event, value): Promise<void> => {
			await withKnownOpenProject(value.cwd, async (canonicalCwd) => {
				await projectLauncher.launchDefault(
					canonicalCwd,
					value.kind,
					settings.getAppSettings().projectLaunchers[value.kind],
				);
			});
		},

		[projectProcedures.remove.channel]: async (_event, cwd): Promise<ProjectRemovalOutcome> => {
			await projectsRestored;
			assertKnownWorkspaceRoot(cwd, piWorker.listOpenProjectPaths());
			return mutateList(() => removeProjectAndPersist(cwd, afterRuntimeClose ? { afterRuntimeClose } : {}));
		},
	};
	return { handlers, dispose: unsubscribeReload };
}
