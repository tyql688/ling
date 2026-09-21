import { Button } from "@renderer/components/ui/button";

import { FeedbackNotice } from "@renderer/components/ui/feedback";

import { LoadingTransition } from "@renderer/components/ui/loading-transition";

import { SettingsPage } from "@renderer/components/ui/settings-page";

import { SettingsRetryAction, SettingsState } from "@renderer/components/ui/settings-state";

import { Boxes, Plus, RefreshCw } from "lucide-react";

import { ModelsAddProviderDialog } from "./models-editor-dialogs";

import { ModelsModelEditorDialog } from "./model-editor-dialog";

import { ModelConfigurationDialog } from "./model-configuration-dialog";

import { ModelsLoginDialog } from "./models-login-dialog";

import { ModelsProviderDetail } from "./models-provider-detail";

import { ModelsProviderList } from "./models-provider-list";

import { useModelsView, type ModelsViewProps } from "./use-models-view";

export function ModelsView(props: ModelsViewProps) {
	const {
		t,
		catalogRefreshing,
		cancelCatalogRefresh,
		refreshCatalogs,
		providers,
		busy,
		error,
		refresh,
		catalogRefreshResult,
		catalogRefreshWarn,
		providerList,
		setAddProviderOpen,
		modelsContainerRef,
		visiblePane,
		selected,
		selectProvider,
		dispatchNavigation,
		getApiKey,
		setApiKey,
		removeAuth,
		setLogin,
		setModelForm,
		setModelDetails,
		removeModel,
		removeProvider,
		updateProvider,
		login,
		addProviderOpen,
		modelDetails,
		modelForm,
	} = useModelsView(props);

	return (
		<SettingsPage
			title={t("models.title")}
			scrollable={false}
			actions={
				<Button
					variant="outline"
					size="sm"
					onClick={() => {
						if (catalogRefreshing) {
							void cancelCatalogRefresh();
						} else {
							void refreshCatalogs();
						}
					}}
					disabled={(providers === null || busy) && !catalogRefreshing}
					aria-busy={catalogRefreshing}
					className="min-h-11 sm:min-h-7"
				>
					<RefreshCw className={`size-3.5 ${catalogRefreshing ? "animate-spin" : ""}`} aria-hidden="true" />
					{catalogRefreshing ? t("models.cancelCatalogRefresh") : t("models.updateCatalogs")}
				</Button>
			}
		>
			{error && providers !== null && (
				<FeedbackNotice
					tone="danger"
					title={t("models.loadFailed")}
					action={<SettingsRetryAction label={t("models.retry")} onClick={() => void refresh()} />}
				>
					{error}
				</FeedbackNotice>
			)}
			<ModelCatalogRefreshNotice
				catalogRefreshResult={catalogRefreshResult}
				catalogRefreshWarn={catalogRefreshWarn}
				t={t}
			/>
			<ModelCatalogAdoptions catalogRefreshResult={catalogRefreshResult} t={t} />

			{providers === null ? (
				error ? (
					<SettingsState
						icon={Boxes}
						title={t("models.loadFailed")}
						description={error}
						tone="danger"
						action={<SettingsRetryAction label={t("models.retry")} onClick={() => void refresh()} />}
						className="min-h-0 flex-1"
					/>
				) : (
					<LoadingTransition label={t("models.loading")} className="min-h-0 flex-1" />
				)
			) : providerList.length === 0 ? (
				<SettingsState
					icon={Boxes}
					title={t("models.emptyTitle")}
					description={t("models.emptyDescription")}
					action={
						<Button size="sm" onClick={() => setAddProviderOpen(true)}>
							<Plus className="size-3.5" aria-hidden="true" />
							{t("models.addProvider")}
						</Button>
					}
					className="min-h-0 flex-1"
				/>
			) : (
				<div
					ref={modelsContainerRef}
					className="models-container flex min-h-0 flex-1 overflow-hidden rounded-panel border border-border-subtle bg-surface"
					data-mobile-pane={visiblePane}
				>
					<ModelsProviderList
						providers={providerList}
						selectedId={selected?.id ?? null}
						busy={busy || catalogRefreshing}
						onSelect={selectProvider}
						onAddProvider={() => setAddProviderOpen(true)}
					/>
					<section
						aria-label={t("models.providerDetailRegion")}
						className="models-provider-detail flex min-w-0 flex-1 flex-col overflow-y-auto"
					>
						{selected && (
							<ModelsProviderDetail
								// Provider identity is also the credential-draft lifetime boundary.
								key={`${selected.projectCwd ?? "profile"}:${selected.id}`}
								provider={selected}
								busy={busy || catalogRefreshing || selected.authConflict}
								onBack={() => dispatchNavigation({ type: "showProviders" })}
								onGetApiKey={() => getApiKey({ provider: selected.id, cwd: selected.projectCwd })}
								onSaveKey={(key) => setApiKey(selected.id, key)}
								onRemoveAuth={() => void removeAuth({ provider: selected.id, cwd: selected.projectCwd })}
								onLogin={(method) => setLogin({ provider: selected, method })}
								onAddModel={() => setModelForm({ provider: selected, initial: null, referenceId: null })}
								onEditModel={(model) => setModelForm({ provider: selected, initial: model, referenceId: null })}
								onViewModel={(model) => setModelDetails({ provider: selected, model })}
								onDeriveModel={(model) => setModelForm({ provider: selected, initial: null, referenceId: model.id })}
								onRemoveModel={(modelId) => void removeModel(selected.id, modelId)}
								onRemoveProvider={() => void removeProvider(selected.id)}
								onUpdateProvider={(fields) => updateProvider({ provider: selected.id, ...fields })}
							/>
						)}
					</section>
				</div>
			)}

			{login && <ModelsLoginDialog provider={login.provider} method={login.method} onClose={() => setLogin(null)} />}
			{addProviderOpen && (
				<ModelsAddProviderDialog
					onClose={() => setAddProviderOpen(false)}
					onCreated={(providerId) => selectProvider(providerId)}
				/>
			)}
			{modelDetails && (
				<ModelConfigurationDialog
					provider={modelDetails.provider}
					model={modelDetails.model}
					onClose={() => setModelDetails(null)}
					onDerive={() => {
						setModelForm({ provider: modelDetails.provider, initial: null, referenceId: modelDetails.model.id });
						setModelDetails(null);
					}}
					onEdit={() => {
						setModelForm({ provider: modelDetails.provider, initial: modelDetails.model, referenceId: null });
						setModelDetails(null);
					}}
				/>
			)}
			{modelForm !== null && (
				<ModelsModelEditorDialog
					provider={modelForm.provider.id}
					models={modelForm.provider.models}
					referenceId={modelForm.referenceId}
					initial={modelForm.initial}
					onClose={() => setModelForm(null)}
				/>
			)}
		</SettingsPage>
	);
}

function ModelCatalogRefreshNotice({
	catalogRefreshResult,
	catalogRefreshWarn,
	t,
}: Pick<ReturnType<typeof useModelsView>, "catalogRefreshResult" | "catalogRefreshWarn" | "t">) {
	return (
		catalogRefreshResult &&
		catalogRefreshWarn && (
			<FeedbackNotice tone="warning">
				<p>
					{catalogRefreshResult.timedOut
						? t("models.catalogRefreshTimedOut")
						: catalogRefreshResult.aborted
							? t("models.catalogRefreshCancelled")
							: catalogRefreshResult.errors.length > 0
								? t("models.catalogRefreshPartial", { count: catalogRefreshResult.errors.length })
								: t("models.catalogRefreshSuccess")}
				</p>
				{catalogRefreshResult.errors.length > 0 && (
					<ul className="mt-1 list-inside list-disc">
						{catalogRefreshResult.errors.map((failure) => (
							<li key={failure.provider}>
								{failure.provider}: {failure.message}
							</li>
						))}
					</ul>
				)}
			</FeedbackNotice>
		)
	);
}

function ModelCatalogAdoptions({
	catalogRefreshResult,
	t,
}: Pick<ReturnType<typeof useModelsView>, "catalogRefreshResult" | "t">) {
	return (
		catalogRefreshResult &&
		catalogRefreshResult.adoptedModels.length > 0 && (
			<FeedbackNotice tone="info">
				<details>
					<summary className="cursor-pointer">
						{t("models.catalogModelsAdopted", { count: catalogRefreshResult.adoptedModels.length })}
					</summary>
					<ul className="mt-2 max-h-32 overflow-y-auto font-mono text-xs">
						{catalogRefreshResult.adoptedModels.map((model) => (
							<li key={JSON.stringify([model.provider, model.modelId])}>
								{model.provider}/{model.modelId}
							</li>
						))}
					</ul>
					{catalogRefreshResult.backupPath !== null && (
						<p className="mt-2 break-all text-xs">
							{t("models.catalogModelsBackup", { path: catalogRefreshResult.backupPath })}
						</p>
					)}
				</details>
			</FeedbackNotice>
		)
	);
}
