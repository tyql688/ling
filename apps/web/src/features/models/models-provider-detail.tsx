import type { ProviderSummary } from "@ling/contracts/model";
import { ProviderConfiguration } from "./provider-configuration";

import { ProviderGlyph } from "@renderer/features/models/provider-glyph";

import { Badge } from "@renderer/components/ui/badge";

import { Button } from "@renderer/components/ui/button";

import { ConfirmDialog } from "@renderer/components/ui/confirm-dialog";

import { FeedbackNotice } from "@renderer/components/ui/feedback";

import { Input } from "@renderer/components/ui/input";

import { SettingsCollection } from "@renderer/components/ui/settings-list";

import { SettingsState } from "@renderer/components/ui/settings-state";

import { ArrowLeft, Boxes, Check, CopyPlus, Eye, EyeOff, LogIn, Pencil, Plus, Trash2 } from "lucide-react";

import { useTranslation } from "react-i18next";

import { useProviderDetail, type ModelsProviderDetailProps } from "./use-provider-detail";

function StatusBadge({ provider }: { provider: ProviderSummary }) {
	const { t } = useTranslation();
	if (provider.authConflict) return <Badge variant="danger">{t("models.credentialConflict")}</Badge>;
	if (
		provider.credentialStatus === "unknown" &&
		(!provider.configured || provider.source === null || provider.source === "stored")
	) {
		return <Badge variant="danger">{t("models.credentialUnknown")}</Badge>;
	}
	if (provider.credentialType === "oauth") return <Badge variant="success">{t("models.connectedOauth")}</Badge>;
	if (provider.credentialType === "api_key") return <Badge variant="success">{t("models.connectedApiKey")}</Badge>;
	if (provider.source === "environment") {
		return <Badge variant="accent">{t("models.connectedEnv", { name: provider.sourceLabel ?? "env" })}</Badge>;
	}
	if (provider.configured) return <Badge variant="accent">{t("models.connectedOther")}</Badge>;
	return <Badge>{t("models.notConfigured")}</Badge>;
}
export function ModelsProviderDetail(props: ModelsProviderDetailProps) {
	const {
		detailTitleId,
		onBack,
		t,
		provider,
		busy,
		pushUpdate,
		setConfirmRemove,
		onLogin,
		showKey,
		activeRevealedKey,
		keyDraft,
		revealingKey,
		setKeyDraft,
		revealFence,
		setRevealedKey,
		setKeyRevealOwner,
		toggleKeyVisibility,
		keyDirty,
		saveKey,
		modelListTitleId,
		onAddModel,
		modelSearchId,
		modelQuery,
		setModelQuery,
		visibleModels,
		onViewModel,
		formatContextWindow,
		i18n,
		onDeriveModel,
		onEditModel,
		onRemoveModel,
		setConfirmRemoveProvider,
		confirmRemove,
		setKeyVisibilityOwner,
		onRemoveAuth,
		confirmRemoveProvider,
		onRemoveProvider,
	} = useProviderDetail(props);

	return (
		<section aria-labelledby={detailTitleId} className="flex min-w-0 flex-col gap-5 p-4 sm:gap-6 sm:p-6">
			<Button
				variant="ghost"
				size="sm"
				onClick={onBack}
				data-models-back
				className="models-provider-back min-h-11 self-start"
			>
				<ArrowLeft className="size-4" aria-hidden="true" />
				{t("models.backToProviders")}
			</Button>

			<header className="flex min-w-0 flex-wrap items-center gap-2.5 sm:gap-3">
				<div className="flex size-9 shrink-0 items-center justify-center rounded-control border border-border-subtle bg-surface">
					<ProviderGlyph provider={provider.id} size={20} />
				</div>
				<h2 id={detailTitleId} className="min-w-0 flex-1 truncate text-base font-semibold text-text-primary">
					{provider.displayName}
				</h2>
				<StatusBadge provider={provider} />
				{provider.projectExtension && <Badge variant="accent">{t("models.projectExtensionBadge")}</Badge>}
				{provider.custom && <Badge>{t("models.customBadge")}</Badge>}
				<span className="w-full break-all pl-11 font-mono text-xs text-text-muted sm:ml-auto sm:w-auto sm:pl-0">
					{provider.id}
				</span>
			</header>
			{provider.authConflict && <FeedbackNotice tone="warning">{t("models.projectCredentialConflict")}</FeedbackNotice>}

			<ProviderConfiguration provider={provider} busy={busy} save={pushUpdate} />

			{provider.authMethods.oauth !== null && (
				<section aria-labelledby={`${detailTitleId}-oauth`} className="flex flex-col gap-2">
					<h3 id={`${detailTitleId}-oauth`} className="text-xs font-medium text-text-muted">
						{t("models.oauthSection")}
					</h3>
					{provider.credentialType === "oauth" ? (
						<div className="flex flex-col gap-2 rounded-control border border-border-subtle px-3 py-2.5 sm:flex-row sm:items-center">
							<div className="flex min-w-0 flex-1 items-center gap-2">
								<Check className="size-4 shrink-0 text-success" aria-hidden="true" />
								<span className="min-w-0 flex-1 text-sm text-text-primary sm:truncate">
									{t("models.oauthLoggedIn", { name: provider.authMethods.oauth.name })}
								</span>
							</div>
							<Button
								variant="outline"
								size="sm"
								disabled={busy}
								onClick={() => setConfirmRemove(true)}
								className="min-h-11 sm:min-h-7"
							>
								{t("models.logout")}
							</Button>
						</div>
					) : (
						<div>
							<Button
								variant="outline"
								size="sm"
								disabled={busy}
								onClick={() => onLogin("oauth")}
								className="min-h-11 sm:min-h-7"
							>
								<LogIn className="size-3.5" aria-hidden="true" />
								{provider.authMethods.oauth.loginLabel ??
									t("models.oauthLogin", { name: provider.authMethods.oauth.name })}
							</Button>
						</div>
					)}
				</section>
			)}

			<ProviderApiKeySection
				provider={provider}
				detailTitleId={detailTitleId}
				showKey={showKey}
				t={t}
				activeRevealedKey={activeRevealedKey}
				keyDraft={keyDraft}
				revealingKey={revealingKey}
				setKeyDraft={setKeyDraft}
				revealFence={revealFence}
				setRevealedKey={setRevealedKey}
				setKeyRevealOwner={setKeyRevealOwner}
				busy={busy}
				toggleKeyVisibility={toggleKeyVisibility}
				keyDirty={keyDirty}
				saveKey={saveKey}
				setConfirmRemove={setConfirmRemove}
				onLogin={onLogin}
			/>

			<section aria-labelledby={modelListTitleId} className="flex flex-col gap-3">
				<div className="flex flex-wrap items-center justify-between gap-2">
					<h3 id={modelListTitleId} className="text-xs font-medium text-text-muted">
						{t("models.modelList", { count: provider.models.length })}
					</h3>
					{!provider.projectExtension && (
						<Button size="sm" disabled={busy} onClick={onAddModel} className="min-h-11 sm:min-h-7">
							<Plus className="size-3.5" aria-hidden="true" />
							{t("models.addModel")}
						</Button>
					)}
				</div>
				<div className="flex flex-col gap-1.5">
					<label htmlFor={modelSearchId} className="sr-only">
						{t("models.searchModels")}
					</label>
					<Input
						id={modelSearchId}
						type="search"
						value={modelQuery}
						onChange={(event) => setModelQuery(event.target.value)}
						placeholder={t("models.searchModels")}
						className="h-11 sm:h-9"
					/>
				</div>
				{visibleModels.length === 0 ? (
					<SettingsState
						icon={Boxes}
						title={t(provider.models.length === 0 ? "models.noModelsTitle" : "models.noMatchingModels")}
						description={t(provider.models.length === 0 ? "models.noModels" : "models.modelIdHint")}
						compact
					/>
				) : (
					<SettingsCollection>
						{visibleModels.map((model) => (
							<div key={model.id} className="flex min-h-11 flex-wrap items-center gap-2 px-3 py-3">
								<ProviderGlyph provider={provider.id} size={16} className="shrink-0" />
								<button
									type="button"
									onClick={() => onViewModel(model)}
									className="min-w-0 flex-1 rounded-control text-left focus-visible:bg-surface-hover"
								>
									<span className="block break-all text-sm text-text-primary">{model.name}</span>
									<span className="block break-all font-mono text-xs text-text-muted">{model.id}</span>
								</button>
								{model.definition !== null && <Badge>{t("models.customBadge")}</Badge>}
								{model.reasoning && <Badge>{t("models.reasoning")}</Badge>}
								<Badge>{formatContextWindow(model.contextWindow, i18n.language)}</Badge>
								<div className="ml-auto flex items-center gap-1">
									<Button variant="ghost" size="sm" onClick={() => onViewModel(model)} className="min-h-11 sm:min-h-7">
										{t("models.viewConfiguration")}
									</Button>
									{!provider.projectExtension && (
										<Button
											variant="ghost"
											size="icon"
											disabled={busy}
											onClick={() => onDeriveModel(model)}
											aria-label={t("models.addFromModel")}
											title={t("models.addFromModel")}
										>
											<CopyPlus className="size-3.5" aria-hidden="true" />
										</Button>
									)}
									{!provider.projectExtension && model.definition !== null && (
										<>
											<Button
												variant="ghost"
												size="icon"
												disabled={busy}
												onClick={() => onEditModel(model)}
												aria-label={t("models.editModel")}
											>
												<Pencil className="size-3.5" aria-hidden="true" />
											</Button>
											<Button
												variant="ghost"
												size="icon"
												disabled={busy}
												onClick={() => onRemoveModel(model.id)}
												aria-label={t("models.removeModel")}
											>
												<Trash2 className="size-3.5" aria-hidden="true" />
											</Button>
										</>
									)}
								</div>
							</div>
						))}
					</SettingsCollection>
				)}
			</section>

			{provider.custom && (
				<div>
					<Button
						variant="outline"
						size="sm"
						disabled={busy}
						onClick={() => setConfirmRemoveProvider(true)}
						className="min-h-11 text-danger hover:bg-danger/10 sm:min-h-7"
					>
						<Trash2 className="size-3.5" aria-hidden="true" />
						{t("models.removeProvider")}
					</Button>
				</div>
			)}

			<ConfirmDialog
				open={confirmRemove}
				title={t("models.confirmRemove", { name: provider.displayName })}
				confirmLabel={t("models.removeConfirm")}
				cancelLabel={t("models.cancel")}
				destructive
				onConfirm={() => {
					setConfirmRemove(false);
					revealFence.invalidate();
					setRevealedKey(null);
					setKeyVisibilityOwner(null);
					setKeyRevealOwner(null);
					onRemoveAuth();
				}}
				onCancel={() => setConfirmRemove(false)}
			/>
			<ConfirmDialog
				open={confirmRemoveProvider}
				title={t("models.confirmRemoveProvider", { name: provider.displayName })}
				confirmLabel={t("models.removeConfirm")}
				cancelLabel={t("models.cancel")}
				destructive
				onConfirm={() => {
					setConfirmRemoveProvider(false);
					onRemoveProvider();
				}}
				onCancel={() => setConfirmRemoveProvider(false)}
			/>
		</section>
	);
}

function ProviderApiKeySection({
	provider,
	detailTitleId,
	showKey,
	t,
	activeRevealedKey,
	keyDraft,
	revealingKey,
	setKeyDraft,
	revealFence,
	setRevealedKey,
	setKeyRevealOwner,
	busy,
	toggleKeyVisibility,
	keyDirty,
	saveKey,
	setConfirmRemove,
	onLogin,
}: Pick<
	ReturnType<typeof useProviderDetail>,
	| "provider"
	| "detailTitleId"
	| "showKey"
	| "t"
	| "activeRevealedKey"
	| "keyDraft"
	| "revealingKey"
	| "setKeyDraft"
	| "revealFence"
	| "setRevealedKey"
	| "setKeyRevealOwner"
	| "busy"
	| "toggleKeyVisibility"
	| "keyDirty"
	| "saveKey"
	| "setConfirmRemove"
	| "onLogin"
>) {
	return (
		provider.authMethods.apiKey !== null && (
			<section aria-labelledby={`${detailTitleId}-api-key`} className="flex flex-col gap-2">
				<h3 id={`${detailTitleId}-api-key`} className="text-xs font-medium text-text-muted">
					{provider.authMethods.apiKey.name}
				</h3>
				{provider.custom ? (
					<div className="flex flex-col gap-2 sm:flex-row">
						<div className="relative min-w-0 flex-1">
							<Input
								aria-labelledby={`${detailTitleId}-api-key`}
								type={showKey ? "text" : "password"}
								placeholder={
									provider.credentialType === "api_key"
										? t("models.apiKeyReplacePlaceholder")
										: t("models.apiKeyPlaceholder")
								}
								value={activeRevealedKey ?? keyDraft}
								readOnly={revealingKey}
								onChange={(event) => {
									setKeyDraft(event.target.value);
									revealFence.invalidate();
									setRevealedKey(null);
									setKeyRevealOwner(null);
								}}
								className="h-11 pr-11 font-mono sm:h-9 sm:pr-9"
							/>
							{(provider.credentialType === "api_key" || keyDraft !== "") && (
								<button
									type="button"
									disabled={busy || revealingKey}
									onClick={() => void toggleKeyVisibility()}
									aria-label={showKey ? t("models.hideKey") : t("models.showKey")}
									className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-text-muted hover:text-text-primary disabled:opacity-50 sm:right-1 sm:w-8"
								>
									{showKey ? (
										<EyeOff className="size-4" aria-hidden="true" />
									) : (
										<Eye className="size-4" aria-hidden="true" />
									)}
								</button>
							)}
						</div>
						<div className="flex gap-2">
							<Button
								size="sm"
								disabled={busy || !keyDirty}
								onClick={() => void saveKey()}
								className="min-h-11 flex-1 sm:min-h-7 sm:flex-none"
							>
								{t("models.saveKey")}
							</Button>
							{provider.credentialType === "api_key" && (
								<Button
									variant="outline"
									size="sm"
									disabled={busy}
									onClick={() => setConfirmRemove(true)}
									className="min-h-11 flex-1 sm:min-h-7 sm:flex-none"
								>
									{t("models.removeKey")}
								</Button>
							)}
						</div>
					</div>
				) : provider.credentialType === "api_key" ? (
					<div className="flex flex-col gap-2 rounded-control border border-border-subtle px-3 py-2.5 sm:flex-row sm:items-center">
						<div className="flex min-w-0 flex-1 items-center gap-2">
							<Check className="size-4 shrink-0 text-success" aria-hidden="true" />
							<span className="min-w-0 flex-1 text-sm text-text-primary sm:truncate">
								{t("models.apiKeyConfigured")}
							</span>
						</div>
						{provider.authMethods.apiKey.interactive && (
							<Button
								variant="outline"
								size="sm"
								disabled={busy}
								onClick={() => onLogin("api_key")}
								className="min-h-11 sm:min-h-7"
							>
								{t("models.reconfigure")}
							</Button>
						)}
						<Button
							variant="outline"
							size="sm"
							disabled={busy}
							onClick={() => setConfirmRemove(true)}
							className="min-h-11 sm:min-h-7"
						>
							{t("models.removeKey")}
						</Button>
					</div>
				) : provider.authMethods.apiKey.interactive ? (
					<div>
						<Button
							variant="outline"
							size="sm"
							disabled={busy}
							onClick={() => onLogin("api_key")}
							className="min-h-11 sm:min-h-7"
						>
							<LogIn className="size-3.5" aria-hidden="true" />
							{t("models.configureApiKey")}
						</Button>
					</div>
				) : (
					<p className="text-xs text-text-muted">{t("models.ambientAuthOnly")}</p>
				)}
				{provider.source === "environment" && (
					<p className="text-xs text-text-muted">{t("models.envHint", { name: provider.sourceLabel ?? "env" })}</p>
				)}
			</section>
		)
	);
}
