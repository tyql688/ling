import type { DataStoreIssue } from "@ling/contracts/data-store";
import { toError } from "@ling/core/ling-error";
import type { HostBusinessHandlersOptions } from "./business-handlers";
import { createDraftStore } from "../domains/data/draft-store";
import { createUserStateStore } from "../domains/data/user-state-store";

/** Composition supplies recovery ports; data handlers do not reach into other domains or request handlers. */
export function createDataSources(options: HostBusinessHandlersOptions) {
	const { database, projects, sessions, settings, piWorker, projectsRestored } = options;
	const drafts = createDraftStore(database),
		userState = createUserStateStore(database);
	async function collect(retry: boolean): Promise<DataStoreIssue[]> {
		const issues: DataStoreIssue[] = [];
		async function inspect(key: string, operation: () => unknown) {
			try {
				await operation();
			} catch (error) {
				issues.push({ key, source: database.path, message: toError(error).message });
			}
		}
		await inspect("ling/app-settings", () => {
			settings.getAppSettings();
		});
		await inspect("ling/projects", async () => {
			if (retry) {
				await projectsRestored;
				const issue = projects.recovery.getIssue();
				await projects.runProjectMutation(() =>
					issue?.kind === "write" ? projects.persistOpenProjects() : projects.restoreOpenProjects(),
				);
				if (issue?.kind === "write") projects.recovery.clearWriteError();
			}
			const issue = projects.recovery.getIssue();
			if (issue) throw issue.error;
		});
		await inspect("ling/session-catalog", async () => {
			if (retry) {
				await sessions.catalog.retryRead();
				const discovered = await sessions.listCache.listSessionsFromCatalogCache(piWorker.listOpenProjectPaths());
				await sessions.catalog.retryPersistence(discovered);
			}
			await sessions.catalog.snapshot();
		});
		await inspect("ling/composer-history", async () => {
			if (retry) await sessions.composerHistory.flushComposerHistoryWrites();
			const status = sessions.composerHistory.inspect();
			if (status.status === "degraded") throw new Error("Prompt history has pending writes that could not be saved");
		});
		await inspect("ling/drafts", () => {
			for (const issue of drafts.list().issues)
				issues.push({ key: `draft:${issue.key}`, source: database.path, message: issue.message });
		});
		await inspect("ling/user-state", () => {
			for (const issue of userState.snapshot().issues)
				issues.push({ key: `user:${issue.key}`, source: database.path, message: issue.message });
		});
		if (retry) await inspect("ling/metadata-cleanup", () => options.metadataCleanup.retryPendingMetadataCleanup());
		return issues;
	}
	return { inspectSources: () => collect(false), retrySources: () => collect(true) };
}
