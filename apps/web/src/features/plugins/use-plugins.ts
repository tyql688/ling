import { useDomainApi } from "@renderer/lib/host-api-context";
import type { PluginMutationResponse, PluginPackageScope } from "@ling/contracts/plugin";
import type { PiResourceReloadSummary } from "@ling/contracts/session";
import { toError } from "@ling/contracts/ling-error";
import { type OperationRef, createBuiltinOperationRef, sameOperationRef } from "@ling/contracts/owner-ref";
import {
	PLUGIN_MUTATION_DEADLINE_MS,
	PLUGIN_MUTATION_OWNER_ID,
	type PluginMutationAction,
	pluginMutationRevision,
} from "@ling/contracts/plugin-operation";
import {
	agentInfoAtom,
	availableUpdatesAtom,
	checkingUpdatesAtom,
	configuredPackagesAtom,
	pluginsBusyAtom,
	pluginsErrorAtom,
	progressLogAtom,
} from "@renderer/features/plugins/state";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

export function usePlugins() {
	const hostPluginsApi = useDomainApi("plugins");
	const hostAgentApi = useDomainApi("agent");
	const hostProjectApi = useDomainApi("project");

	const { t } = useTranslation();
	const agentInfo = useAtomValue(agentInfoAtom);
	const setAgentInfo = useSetAtom(agentInfoAtom);
	const [packages, setPackages] = useAtom(configuredPackagesAtom);
	const [availableUpdates, setAvailableUpdates] = useAtom(availableUpdatesAtom);
	const [checkingUpdates, setCheckingUpdates] = useAtom(checkingUpdatesAtom);
	const [busy, setBusy] = useAtom(pluginsBusyAtom);
	const progressLog = useAtomValue(progressLogAtom);
	const setProgressLog = useSetAtom(progressLogAtom);
	const [error, setError] = useAtom(pluginsErrorAtom);
	const [projectWarning, setProjectWarning] = useState<string | null>(null);
	// Pi packages are treated as globally effective; the first open project only provides
	// the resolution context for listing and mutations.
	const [projectCwd, setProjectCwd] = useState<string | null>(null);
	const [projectListLoaded, setProjectListLoaded] = useState(false);
	const [inventoryScope, setInventoryScope] = useState<{ cwd: string | null } | null>(null);
	const [activeOperation, setActiveOperation] = useState<OperationRef | null>(null);
	const [reloadSummary, setReloadSummary] = useState<PiResourceReloadSummary | null>(null);
	const projectContextRevisionRef = useRef(0);
	const refreshRevisionRef = useRef(0);
	const updateCheckRevisionRef = useRef(0);
	const projectCwdRef = useRef(projectCwd);
	projectCwdRef.current = projectCwd;

	// The atom retains structured error metadata; PluginsView localizes/strips it via formatRequestError at render.
	const fail = useCallback((err: unknown) => setError(toError(err)), [setError]);

	// Hits the npm registry / git remotes in the background. Keep the last known result on
	// failure and surface the error instead of making an unavailable registry look up to date.
	const checkUpdates = useCallback(async () => {
		const scopeCwd = projectCwd;
		if (projectCwdRef.current !== scopeCwd) return;
		updateCheckRevisionRef.current += 1;
		const revision = updateCheckRevisionRef.current;
		if (scopeCwd === null) {
			setAvailableUpdates([]);
			setCheckingUpdates(false);
			return;
		}
		setCheckingUpdates(true);
		try {
			const updates = await hostPluginsApi.checkUpdates({ cwd: scopeCwd });
			if (revision === updateCheckRevisionRef.current && projectCwdRef.current === scopeCwd) {
				setAvailableUpdates(updates);
			}
		} catch (error) {
			if (revision === updateCheckRevisionRef.current && projectCwdRef.current === scopeCwd) fail(error);
		} finally {
			if (revision === updateCheckRevisionRef.current && projectCwdRef.current === scopeCwd) {
				setCheckingUpdates(false);
			}
		}
	}, [hostPluginsApi, projectCwd, fail, setAvailableUpdates, setCheckingUpdates]);

	const refresh = useCallback(
		async (clearError = false) => {
			const scopeCwd = projectCwd;
			if (projectCwdRef.current !== scopeCwd) return;
			refreshRevisionRef.current += 1;
			const revision = refreshRevisionRef.current;
			const [info, nextPackages] = await Promise.all([
				hostAgentApi.getInfo(),
				scopeCwd === null ? Promise.resolve([]) : hostPluginsApi.list({ cwd: scopeCwd }),
			]);
			if (revision !== refreshRevisionRef.current || projectCwdRef.current !== scopeCwd) return;
			setAgentInfo(info);
			setPackages(nextPackages);
			setInventoryScope({ cwd: scopeCwd });
			if (clearError) setError(null);
		},
		[hostAgentApi, hostPluginsApi, projectCwd, setAgentInfo, setError, setPackages],
	);

	const loadProjectContext = useCallback(async () => {
		projectContextRevisionRef.current += 1;
		const revision = projectContextRevisionRef.current;
		setProjectListLoaded(false);
		try {
			const result = await hostProjectApi.list();
			if (revision !== projectContextRevisionRef.current) return;
			const list = result.projects;
			setProjectCwd((current) =>
				current && list.some((project) => project.cwd === current) ? current : (list[0]?.cwd ?? null),
			);
			setProjectListLoaded(true);
			setProjectWarning(
				result.status === "partial"
					? t("project.partialLoad", {
							count: result.failureCount,
							path: result.firstFailure.cwd,
							message: result.firstFailure.message,
						})
					: null,
			);
		} catch (cause) {
			if (revision !== projectContextRevisionRef.current) return;
			setProjectWarning(null);
			fail(cause);
		}
	}, [hostProjectApi, fail, t]);

	useEffect(() => {
		void loadProjectContext();
		const unsubscribe = hostProjectApi.onChanged(() => void loadProjectContext());
		return () => {
			projectContextRevisionRef.current += 1;
			unsubscribe();
		};
	}, [hostProjectApi, loadProjectContext]);

	useEffect(() => {
		if (!projectListLoaded) return undefined;
		refresh()
			.then(() => checkUpdates())
			.catch(fail);
		return () => {
			refreshRevisionRef.current += 1;
			updateCheckRevisionRef.current += 1;
			setCheckingUpdates(false);
		};
	}, [projectListLoaded, refresh, checkUpdates, fail, setCheckingUpdates]);

	useEffect(() => {
		return hostPluginsApi.onProgress((event) => {
			setProgressLog((log) => [...log.slice(-49), event]);
		});
	}, [hostPluginsApi, setProgressLog]);

	const retryLoad = useCallback(() => {
		setError(null);
		if (!projectListLoaded || projectWarning !== null) {
			void loadProjectContext();
			return;
		}
		void refresh()
			.then(() => checkUpdates())
			.catch(fail);
	}, [projectListLoaded, projectWarning, loadProjectContext, refresh, checkUpdates, fail, setError]);

	const run = useCallback(
		async (
			action: PluginMutationAction,
			source: string | null,
			scope: PluginPackageScope | "all",
			invoke: (cwd: string, operation: OperationRef, deadlineAt: number) => Promise<PluginMutationResponse>,
		) => {
			if (projectCwd === null) {
				fail("Open a project before managing Pi packages.");
				return false;
			}
			const operation = createBuiltinOperationRef(crypto.randomUUID(), PLUGIN_MUTATION_OWNER_ID, {
				scope: { kind: "project", ref: { cwd: projectCwd } },
				revision: pluginMutationRevision(action, source, projectCwd, scope),
				generation: 0,
			});
			setBusy(true);
			setError(null);
			setReloadSummary(null);
			setActiveOperation(operation);
			let succeeded = false;
			try {
				const result = await invoke(projectCwd, operation, Date.now() + PLUGIN_MUTATION_DEADLINE_MS);
				if (result.requestId !== operation.requestId) fail("Ling returned a mismatched plugin response.");
				else {
					setReloadSummary(result.reload);
					succeeded = true;
				}
			} catch (err) {
				fail(err);
			} finally {
				try {
					await refresh(false);
				} catch (refreshError) {
					fail(refreshError);
				}
				setActiveOperation((current) => (current && sameOperationRef(current, operation) ? null : current));
				setBusy(false);
			}
			if (succeeded) void checkUpdates();
			return succeeded;
		},
		[projectCwd, refresh, checkUpdates, setBusy, setError, fail],
	);

	const install = useCallback(
		(source: string, scope: PluginPackageScope = "global") =>
			run("install", source, scope, (cwd, operation, deadlineAt) =>
				hostPluginsApi.install({ operation, deadlineAt, cwd, source, scope }),
			),
		[hostPluginsApi, run],
	);

	const remove = useCallback(
		(source: string, scope: PluginPackageScope) =>
			run("remove", source, scope, (cwd, operation, deadlineAt) =>
				hostPluginsApi.remove({ operation, deadlineAt, cwd, source, scope }),
			),
		[hostPluginsApi, run],
	);

	/** null source + all scope updates every configured package. */
	const update = useCallback(
		(source: string | null, scope: PluginPackageScope | "all") =>
			run("update", source, scope, (cwd, operation, deadlineAt) =>
				hostPluginsApi.update({ operation, deadlineAt, cwd, source, scope }),
			),
		[hostPluginsApi, run],
	);

	const cancelOperation = useCallback(async () => {
		if (!activeOperation) return;
		try {
			await hostPluginsApi.cancelOperation({ operation: activeOperation });
		} catch (cause) {
			fail(cause);
		}
	}, [hostPluginsApi, activeOperation, fail]);

	return {
		projectCwd,
		loading: !projectListLoaded || inventoryScope === null || inventoryScope.cwd !== projectCwd,
		agentInfo,
		packages,
		availableUpdates,
		checkingUpdates,
		busy,
		activeOperation,
		progressLog,
		error,
		projectWarning,
		reloadSummary,
		reportError: fail,
		install,
		remove,
		update,
		cancelOperation,
		refresh,
		checkUpdates,
		retryLoad,
	};
}
