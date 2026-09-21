import { useDomainApi } from "@renderer/lib/host-api-context";
import { useDataIssue } from "@renderer/lib/data-health/state";
import type { CreateWorktreeRequest, RemoveWorktreeRequest } from "@ling/contracts/git";
import type { OpenProjectInfo, ProjectRemovalOutcome } from "@ling/contracts/project";
import { openProjectsAtom } from "@renderer/features/projects/state";
import { datasetStoreIssue } from "@renderer/lib/dataset-status";
import { formatRequestError } from "@renderer/lib/errors";
import { createRequestFence, type RequestFence } from "@renderer/lib/request-fence";
import { useAtom } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

const PROJECT_LIST_IDENTITY = "projects";

export function useProjects({ onProjectRemoved }: { onProjectRemoved(cwd: string): void }) {
	const hostProjectApi = useDomainApi("project");
	const hostGitApi = useDomainApi("git");

	const { t } = useTranslation();
	const [projects, setProjects] = useAtom(openProjectsAtom);
	const [loading, setLoading] = useState(true);
	const [repairing, setRepairing] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [warning, setWarning] = useState<string | null>(null);
	const [storeRecoveryError, setStoreRecoveryError] = useState<string | null>(null);
	const [storeRecoveryAllowed, setStoreRecoveryAllowed] = useState(false);
	const [storePersistenceError, setStorePersistenceError] = useState<string | null>(null);
	const [storeRetrying, setStoreRetrying] = useState(false);
	const refreshFenceRef = useRef<RequestFence<typeof PROJECT_LIST_IDENTITY> | null>(null);
	refreshFenceRef.current ??= createRequestFence<typeof PROJECT_LIST_IDENTITY>();
	const refreshFence = refreshFenceRef.current;

	const refresh = useCallback(async () => {
		const request = refreshFence.begin(PROJECT_LIST_IDENTITY);
		setLoading(true);
		try {
			const storeStatus = await hostProjectApi.storeStatus();
			if (!refreshFence.isCurrent(request, PROJECT_LIST_IDENTITY)) return;
			const writeDegraded = storeStatus.status === "degraded";
			if (writeDegraded) {
				setStoreRecoveryError(null);
				setStoreRecoveryAllowed(false);
			} else {
				const issue = datasetStoreIssue(storeStatus, (key, options) =>
					options === undefined ? t(key) : t(key, options),
				);
				if (issue) {
					setWarning(null);
					setStoreRecoveryError(issue.message);
					setStoreRecoveryAllowed(issue.recoverable);
					setStorePersistenceError(null);
					setError(null);
					return;
				}
			}
			const result = await hostProjectApi.list();
			if (!refreshFence.isCurrent(request, PROJECT_LIST_IDENTITY)) return;
			setProjects(result.projects);
			setStoreRecoveryError(null);
			setStoreRecoveryAllowed(false);
			setStorePersistenceError(writeDegraded ? t("project.storeWriteErrorDescription") : null);
			if (result.status === "partial") {
				const message = t("project.partialLoad", {
					count: result.failureCount,
					path: result.firstFailure.cwd,
					message: result.firstFailure.message,
				});
				setWarning(result.projects.length > 0 ? message : null);
				setError(result.projects.length === 0 ? message : null);
			} else {
				setWarning(null);
				setError(null);
			}
		} catch (cause) {
			if (!refreshFence.isCurrent(request, PROJECT_LIST_IDENTITY)) return;
			setWarning(null);
			setError(formatRequestError(cause));
			return { status: "error" as const, error: cause };
		} finally {
			if (refreshFence.isCurrent(request, PROJECT_LIST_IDENTITY)) setLoading(false);
		}
	}, [hostProjectApi, refreshFence, setProjects, t]);

	useEffect(() => {
		void refresh();
		const unsubscribe = hostProjectApi.onChanged(() => void refresh());
		return () => {
			refreshFence.invalidate();
			unsubscribe();
		};
	}, [hostProjectApi, refresh, refreshFence]);

	const repairProjectStore = useCallback(async (): Promise<void> => {
		setRepairing(true);
		try {
			await hostProjectApi.resetStore();
			await refresh();
		} catch (cause) {
			setError(formatRequestError(cause));
		} finally {
			setRepairing(false);
		}
	}, [hostProjectApi, refresh]);

	const retryProjectStore = useCallback(async (): Promise<void> => {
		setStoreRetrying(true);
		try {
			await hostProjectApi.retryStore();
			await refresh();
		} catch (cause) {
			setError(formatRequestError(cause));
		} finally {
			setStoreRetrying(false);
		}
	}, [hostProjectApi, refresh]);

	useDataIssue(
		"ling/projects",
		storeRecoveryError || storePersistenceError
			? {
					label: t("project.storeReadErrorTitle"),
					message: storeRecoveryError ?? storePersistenceError!,
					retry: retryProjectStore,
					...(storeRecoveryAllowed
						? {
								recovery: {
									label: t("project.storeRepair"),
									description: t("project.storeReadErrorDescription", { message: storeRecoveryError }),
									run: repairProjectStore,
								},
							}
						: {}),
				}
			: null,
	);
	const addProject = useCallback(async (): Promise<OpenProjectInfo | null> => {
		const info = await hostProjectApi.add();
		if (info) {
			refreshFence.invalidate();
			setLoading(false);
			setProjects((current) => (current.some((p) => p.cwd === info.cwd) ? current : [...current, info]));
		}
		return info;
	}, [hostProjectApi, refreshFence, setProjects]);

	/** Every removal path retires the same renderer-side project state. */
	const applyProjectRemoval = useCallback(
		(outcome: ProjectRemovalOutcome): ProjectRemovalOutcome => {
			refreshFence.invalidate();
			setLoading(false);
			onProjectRemoved(outcome.cwd);
			setProjects((current) => current.filter((p) => p.cwd !== outcome.cwd));
			setError(outcome.status === "removed-with-warning" ? outcome.warning : null);
			return outcome;
		},
		[onProjectRemoved, refreshFence, setProjects],
	);

	const removeProject = useCallback(
		async (cwd: string): Promise<ProjectRemovalOutcome> => applyProjectRemoval(await hostProjectApi.remove(cwd)),
		[hostProjectApi, applyProjectRemoval],
	);

	const createWorktree = useCallback(
		async (request: CreateWorktreeRequest): Promise<OpenProjectInfo> => {
			const info = await hostGitApi.createWorktree(request);
			refreshFence.invalidate();
			setLoading(false);
			setProjects((current) => (current.some((p) => p.cwd === info.cwd) ? current : [...current, info]));
			return info;
		},
		[hostGitApi, refreshFence, setProjects],
	);

	const removeWorktree = useCallback(
		async (request: RemoveWorktreeRequest): Promise<ProjectRemovalOutcome> =>
			applyProjectRemoval(await hostGitApi.removeWorktree(request)),
		[hostGitApi, applyProjectRemoval],
	);

	return useMemo(
		() => ({
			projects,
			loading,
			repairing,
			error,
			warning,
			storeRecoveryError,
			storeRecoveryAllowed,
			storePersistenceError,
			storeRetrying,
			repairProjectStore,
			retryProjectStore,
			addProject,
			removeProject,
			createWorktree,
			removeWorktree,
			refresh,
		}),
		[
			projects,
			loading,
			repairing,
			error,
			warning,
			storeRecoveryError,
			storeRecoveryAllowed,
			storePersistenceError,
			storeRetrying,
			repairProjectStore,
			retryProjectStore,
			addProject,
			removeProject,
			createWorktree,
			removeWorktree,
			refresh,
		],
	);
}

export type ProjectController = ReturnType<typeof useProjects>;
