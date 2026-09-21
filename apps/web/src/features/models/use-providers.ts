import { errorMessage } from "@ling/contracts/ling-error";
import type {
	ModelCatalogRefreshResult,
	ProviderAuthTarget,
	ProviderSummary,
	UpdateCustomProviderRequest,
} from "@ling/contracts/model";
import { combineProviderCatalogErrors } from "@ling/contracts/model";
import { useDomainApi } from "@renderer/lib/host-api-context";
import { createRequestFence, type RequestFence } from "@renderer/lib/request-fence";
import { useCallback, useEffect, useRef, useState } from "react";
import { mergeProviderCatalogs } from "./provider-catalog";

/** Last fetched catalog per project, so a remounted page paints names immediately
 * instead of flashing raw model ids while the fresh fetch is in flight. */
const providerCatalogCache = new Map<string | null, ProviderSummary[]>();

/** Drops a removed project's catalog; nothing else ever deletes from the cache. */
export function forgetProjectProviderCatalog(cwd: string): void {
	providerCatalogCache.delete(cwd);
}

/**
 * Global provider/credential state for the model settings page. Auth mutations run in
 * the main process against Pi's shared auth.json; MODELS_CHANGED broadcasts keep this
 * list in sync (including after an OAuth login that finishes via the login dialog).
 */
export function useProviders(projectCwd: string | null = null) {
	const hostModelsApi = useDomainApi("models");

	const [providerResult, setProviderResult] = useState<{
		projectCwd: string | null;
		providers: ProviderSummary[];
	} | null>(null);
	const [catalogErrorResult, setCatalogErrorResult] = useState<{
		projectCwd: string | null;
		message: string | null;
	} | null>(null);
	const [actionErrorResult, setActionErrorResult] = useState<{
		projectCwd: string | null;
		message: string | null;
	} | null>(null);
	const [busy, setBusy] = useState(false);
	const [catalogRefreshing, setCatalogRefreshing] = useState(false);
	const [catalogRefreshResult, setCatalogRefreshResult] = useState<ModelCatalogRefreshResult | null>(null);
	const actionRevisionRef = useRef(0);
	const currentProjectCwdRef = useRef(projectCwd);
	if (currentProjectCwdRef.current !== projectCwd) {
		currentProjectCwdRef.current = projectCwd;
		actionRevisionRef.current += 1;
	}
	const pendingActionsRef = useRef(0);
	const catalogRefreshRevisionRef = useRef(0);
	const requestFenceRef = useRef<RequestFence<string | null> | null>(null);
	if (requestFenceRef.current === null) requestFenceRef.current = createRequestFence<string | null>();
	const requestFence = requestFenceRef.current;
	const providers =
		providerResult?.projectCwd === projectCwd
			? providerResult.providers
			: (providerCatalogCache.get(projectCwd) ?? null);
	const catalogError = catalogErrorResult?.projectCwd === projectCwd ? catalogErrorResult.message : null;
	const actionError = actionErrorResult?.projectCwd === projectCwd ? actionErrorResult.message : null;
	const error = combineProviderCatalogErrors(actionError, catalogError);

	const refresh = useCallback(async () => {
		const request = requestFence.begin(projectCwd);
		try {
			const [catalog, projectCatalog] = await Promise.all([
				hostModelsApi.listProviders(),
				projectCwd === null ? Promise.resolve(null) : hostModelsApi.listProjectModels({ cwd: projectCwd }),
			]);
			if (!requestFence.isCurrent(request, currentProjectCwdRef.current)) return;
			const merged = mergeProviderCatalogs(catalog.providers, projectCatalog?.extensionProviders ?? []);
			providerCatalogCache.set(projectCwd, merged);
			setProviderResult({ projectCwd, providers: merged });
			// Surface models.json schema/parse errors from Pi's registry in the page's error box.
			setCatalogErrorResult({
				projectCwd,
				message: combineProviderCatalogErrors(catalog.configError, projectCatalog?.configError),
			});
		} catch (cause) {
			if (!requestFence.isCurrent(request, currentProjectCwdRef.current)) return;
			setCatalogErrorResult({ projectCwd, message: errorMessage(cause) });
		}
	}, [hostModelsApi, projectCwd, requestFence]);

	useEffect(() => {
		void refresh();
		const unsubscribe = hostModelsApi.onChanged(() => void refresh());
		return () => {
			requestFence.invalidate();
			unsubscribe();
		};
	}, [hostModelsApi, refresh, requestFence]);

	const run = useCallback(async (operation: () => Promise<void>): Promise<boolean> => {
		const operationProjectCwd = currentProjectCwdRef.current;
		actionRevisionRef.current += 1;
		const actionRevision = actionRevisionRef.current;
		pendingActionsRef.current += 1;
		setBusy(true);
		try {
			await operation();
			if (currentProjectCwdRef.current === operationProjectCwd && actionRevisionRef.current === actionRevision) {
				setActionErrorResult({ projectCwd: operationProjectCwd, message: null });
			}
			return true;
		} catch (cause) {
			if (currentProjectCwdRef.current === operationProjectCwd && actionRevisionRef.current === actionRevision) {
				setActionErrorResult({
					projectCwd: operationProjectCwd,
					message: errorMessage(cause),
				});
			}
			return false;
		} finally {
			pendingActionsRef.current -= 1;
			setBusy(pendingActionsRef.current > 0);
		}
	}, []);

	const setApiKey = useCallback(
		(provider: string, key: string) => run(() => hostModelsApi.setApiKey({ provider, key })),
		[hostModelsApi, run],
	);

	const getApiKey = useCallback(
		async (target: ProviderAuthTarget): Promise<string | null> => {
			const operationProjectCwd = currentProjectCwdRef.current;
			actionRevisionRef.current += 1;
			const actionRevision = actionRevisionRef.current;
			try {
				const key = await hostModelsApi.getApiKey(target);
				if (currentProjectCwdRef.current !== operationProjectCwd || actionRevisionRef.current !== actionRevision) {
					return null;
				}
				setActionErrorResult({ projectCwd: operationProjectCwd, message: null });
				return key;
			} catch (cause) {
				if (currentProjectCwdRef.current === operationProjectCwd && actionRevisionRef.current === actionRevision) {
					setActionErrorResult({
						projectCwd: operationProjectCwd,
						message: errorMessage(cause),
					});
				}
				return null;
			}
		},
		[hostModelsApi],
	);

	const removeAuth = useCallback(
		(target: ProviderAuthTarget) => run(() => hostModelsApi.removeAuth(target)),
		[hostModelsApi, run],
	);

	const removeModel = useCallback(
		(provider: string, modelId: string) => run(() => hostModelsApi.removeModel({ provider, modelId })),
		[hostModelsApi, run],
	);

	const removeProvider = useCallback(
		(provider: string) => run(() => hostModelsApi.removeProvider(provider)),
		[hostModelsApi, run],
	);

	const updateProvider = useCallback(
		(request: UpdateCustomProviderRequest) => run(() => hostModelsApi.updateProvider(request)),
		[hostModelsApi, run],
	);

	const refreshCatalogs = useCallback(async () => {
		catalogRefreshRevisionRef.current += 1;
		const refreshRevision = catalogRefreshRevisionRef.current;
		actionRevisionRef.current += 1;
		const actionRevision = actionRevisionRef.current;
		const operationProjectCwd = currentProjectCwdRef.current;
		setCatalogRefreshing(true);
		setCatalogRefreshResult(null);
		try {
			const result = await hostModelsApi.refreshCatalogs();
			if (catalogRefreshRevisionRef.current === refreshRevision) setCatalogRefreshResult(result);
			if (currentProjectCwdRef.current === operationProjectCwd && actionRevisionRef.current === actionRevision) {
				setActionErrorResult({ projectCwd: operationProjectCwd, message: null });
			}
		} catch (cause) {
			if (
				catalogRefreshRevisionRef.current === refreshRevision &&
				currentProjectCwdRef.current === operationProjectCwd &&
				actionRevisionRef.current === actionRevision
			) {
				setActionErrorResult({
					projectCwd: operationProjectCwd,
					message: errorMessage(cause),
				});
			}
		} finally {
			if (catalogRefreshRevisionRef.current === refreshRevision) setCatalogRefreshing(false);
		}
	}, [hostModelsApi]);

	const cancelCatalogRefresh = useCallback(async () => {
		actionRevisionRef.current += 1;
		const actionRevision = actionRevisionRef.current;
		const operationProjectCwd = currentProjectCwdRef.current;
		try {
			await hostModelsApi.cancelCatalogRefresh();
			if (currentProjectCwdRef.current === operationProjectCwd && actionRevisionRef.current === actionRevision) {
				setActionErrorResult({ projectCwd: operationProjectCwd, message: null });
			}
		} catch (cause) {
			if (currentProjectCwdRef.current === operationProjectCwd && actionRevisionRef.current === actionRevision) {
				setActionErrorResult({
					projectCwd: operationProjectCwd,
					message: errorMessage(cause),
				});
			}
		}
	}, [hostModelsApi]);

	return {
		providers,
		error,
		busy,
		catalogRefreshing,
		catalogRefreshResult,
		refresh,
		refreshCatalogs,
		cancelCatalogRefresh,
		getApiKey,
		setApiKey,
		removeAuth,
		removeModel,
		removeProvider,
		updateProvider,
	};
}
