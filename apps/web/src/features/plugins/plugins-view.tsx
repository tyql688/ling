import { EmptyState } from "@renderer/components/ui/empty-state";
import { useDomainApi } from "@renderer/lib/host-api-context";
import type { ConfiguredPackage, PluginResourceKind } from "@ling/contracts/plugin";
import { ResourceReloadFeedback } from "@renderer/components/resource-reload-feedback";
import { Badge } from "@renderer/components/ui/badge";
import { Button } from "@renderer/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@renderer/components/ui/dialog";
import { FeedbackNotice } from "@renderer/components/ui/feedback";
import { Input } from "@renderer/components/ui/input";
import { LoadingTransition } from "@renderer/components/ui/loading-transition";
import { SettingsSection } from "@renderer/components/ui/settings-list";
import { SettingsPage } from "@renderer/components/ui/settings-page";
import { SettingsRetryAction, SettingsState } from "@renderer/components/ui/settings-state";
import { formatRequestError } from "@renderer/lib/errors";
import { ArrowUpCircle, ChevronDown, Download, ExternalLink, Package, RefreshCw, X } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { usePlugins } from "./use-plugins";
import { BuiltinFeaturesSection } from "./builtin-features-section";

const RESOURCE_KINDS: PluginResourceKind[] = ["extension", "skill", "prompt", "theme"];

function PluginResourceGroups({ pkg }: { pkg: ConfiguredPackage }) {
	const { t } = useTranslation();
	return (
		<div className="border-border-subtle border-t bg-surface-raised/20 px-4 py-2 sm:pl-15">
			{RESOURCE_KINDS.map((kind) => {
				const resources = pkg.resources.filter((resource) => resource.kind === kind);
				if (resources.length === 0) return null;
				return (
					<div key={kind} className="border-border-subtle py-2.5 not-first:border-t">
						<div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-text-muted">
							{t(`plugins.resourceKind.${kind}`, { count: resources.length })}
						</div>
						<div className="flex flex-col gap-1.5">
							{resources.map((resource) => (
								<div
									key={`${resource.kind}:${resource.relativePath}`}
									className="grid min-w-0 gap-0.5 text-xs sm:grid-cols-[minmax(8rem,0.6fr)_minmax(0,1fr)] sm:gap-3"
								>
									<div className="flex min-w-0 items-center gap-1.5">
										<code className="truncate text-text-primary">{resource.name}</code>
										{!resource.enabled && <Badge>{t("plugins.resourceDisabled")}</Badge>}
									</div>
									<code className="truncate text-xs text-text-muted" title={resource.relativePath}>
										{resource.relativePath}
									</code>
								</div>
							))}
						</div>
					</div>
				);
			})}
		</div>
	);
}

function packageSummary(pkg: ConfiguredPackage, t: ReturnType<typeof useTranslation>["t"]): string {
	const parts = RESOURCE_KINDS.flatMap((kind) =>
		pkg.counts[kind] > 0 ? [t(`plugins.resourceKind.${kind}`, { count: pkg.counts[kind] })] : [],
	);
	if (parts.length > 0) return parts.join(" · ");
	return t(pkg.resolution === "missing" ? "plugins.missingDescription" : "plugins.noActiveResourcesDescription");
}

export function PluginsView() {
	const hostAppApi = useDomainApi("app");

	const { t } = useTranslation();
	const {
		projectCwd,
		loading,
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
		reportError,
		install,
		remove,
		update,
		cancelOperation,
		refresh,
		checkUpdates,
		retryLoad,
	} = usePlugins();
	const installId = useId();
	const [source, setSource] = useState("");
	const [expandedPackages, setExpandedPackages] = useState<ReadonlySet<string>>(() => new Set());
	const [pendingRemove, setPendingRemove] = useState<{ source: string; scope: "global" | "project" } | null>(null);
	const updatableSources = useMemo(() => new Set(availableUpdates.map((item) => item.source)), [availableUpdates]);
	const openExternal = (url: string): void => {
		void hostAppApi.openExternal(url).catch(reportError);
	};
	const formattedError = error === null ? null : formatRequestError(error, t);

	return (
		<SettingsPage title={t("plugins.title")} description={t("plugins.pageDescription")}>
			<BuiltinFeaturesSection />
			<SettingsSection title={t("plugins.installSection")}>
				<form
					className="flex flex-col gap-3 px-4 py-4 sm:px-5"
					onSubmit={(event) => {
						event.preventDefault();
						const value = source.trim();
						if (!value || busy || loading || projectCwd === null) return;
						void install(value).then((succeeded) => {
							if (succeeded) setSource((current) => (current.trim() === value ? "" : current));
						});
					}}
				>
					<div className="flex flex-col gap-1">
						<label htmlFor={installId} className="text-sm font-medium">
							{t("plugins.installSource")}
						</label>
						<p id={`${installId}-description`} className="text-ui text-text-muted">
							{t("plugins.installHint")}
						</p>
					</div>
					<div className="flex items-center gap-2">
						<Input
							id={installId}
							aria-describedby={`${installId}-description`}
							placeholder={t("plugins.installPlaceholder")}
							value={source}
							disabled={busy || loading}
							onChange={(event) => setSource(event.target.value)}
							className="min-w-0 flex-1"
						/>
						<Button type="submit" disabled={busy || loading || projectCwd === null || !source.trim()}>
							<Download className="size-3.5" aria-hidden="true" />
							{t("plugins.install")}
						</Button>
					</div>
				</form>
			</SettingsSection>

			{formattedError && !loading && (
				<FeedbackNotice
					tone="danger"
					title={t("plugins.loadFailed")}
					action={<SettingsRetryAction label={t("plugins.retry")} onClick={retryLoad} />}
				>
					{formattedError}
				</FeedbackNotice>
			)}
			{projectWarning && (
				<FeedbackNotice
					tone="warning"
					title={t("project.partialLoadTitle")}
					action={<SettingsRetryAction label={t("project.loadRetry")} onClick={retryLoad} />}
				>
					{projectWarning}
				</FeedbackNotice>
			)}
			{reloadSummary && <ResourceReloadFeedback summary={reloadSummary} />}

			<SettingsSection
				title={t("plugins.installedSection")}
				description={t("plugins.piVersion", { version: agentInfo?.piVersion ?? "…" })}
				action={
					<div className="flex flex-wrap items-center gap-2">
						{busy && activeOperation && (
							<Button variant="outline" size="sm" onClick={() => void cancelOperation()}>
								<X className="size-3.5" aria-hidden="true" />
								{t("plugins.cancelOperation")}
							</Button>
						)}
						<Button variant="outline" size="sm" onClick={() => openExternal("https://pi.dev/packages")}>
							<ExternalLink className="size-3.5" aria-hidden="true" />
							{t("plugins.browseCatalog")}
						</Button>
						{packages.length > 0 && (
							<Button variant="outline" size="sm" onClick={() => void update(null, "all")} disabled={busy}>
								<ArrowUpCircle className="size-3.5" aria-hidden="true" />
								{availableUpdates.length > 0
									? t("plugins.updateAllCount", { count: availableUpdates.length })
									: t("plugins.updateAll")}
							</Button>
						)}
						<Button
							variant="outline"
							size="sm"
							onClick={() => {
								void refresh(true)
									.then(() => checkUpdates())
									.catch(reportError);
							}}
							disabled={busy || checkingUpdates || loading}
						>
							<RefreshCw className="size-3.5" aria-hidden="true" />
							{checkingUpdates ? t("plugins.checkingUpdates") : t("plugins.refresh")}
						</Button>
					</div>
				}
			>
				{loading ? (
					formattedError ? (
						<SettingsState
							icon={Package}
							title={t("plugins.loadFailed")}
							description={formattedError}
							tone="danger"
							action={<SettingsRetryAction label={t("plugins.retry")} onClick={retryLoad} />}
							compact
							className="rounded-none border-0"
						/>
					) : (
						<LoadingTransition label={t("plugins.loading")} className="min-h-28" />
					)
				) : projectCwd === null ? (
					<SettingsState
						icon={Package}
						title={t("plugins.openProjectRequired")}
						description={t("plugins.openProjectHint")}
						compact
						className="rounded-none border-0"
					/>
				) : packages.length === 0 ? (
					<EmptyState
						icon={Package}
						title={t("plugins.empty")}
						description={t("plugins.emptyDescription")}
						className="rounded-none border-0"
					/>
				) : (
					packages.map((pkg) => {
						const packageKey = `${pkg.scope}:${pkg.source}`;
						const expanded = expandedPackages.has(packageKey);
						const canExpand = pkg.resources.length > 0;
						return (
							<div key={packageKey}>
								<div className="flex flex-wrap items-center gap-3 px-4 py-3">
									<button
										type="button"
										disabled={!canExpand}
										aria-expanded={canExpand ? expanded : undefined}
										onClick={() =>
											setExpandedPackages((current) => {
												const next = new Set(current);
												if (next.has(packageKey)) next.delete(packageKey);
												else next.add(packageKey);
												return next;
											})
										}
										className="flex min-w-0 flex-1 items-center gap-3 rounded-control text-left transition-colors focus-visible:bg-surface-hover/50 disabled:cursor-default"
									>
										<div className="flex size-8 shrink-0 items-center justify-center rounded-control bg-surface-hover">
											<Package className="size-4 text-text-muted" aria-hidden="true" />
										</div>
										<div className="min-w-0 flex-1">
											<div className="flex min-w-0 flex-wrap items-center gap-2">
												<span className="truncate text-sm font-medium text-text-primary">{pkg.source}</span>
												<Badge>{t(`plugins.scope.${pkg.scope}`)}</Badge>
												<Badge
													variant={
														pkg.resolution === "loaded"
															? "success"
															: pkg.resolution === "missing"
																? "danger"
																: "default"
													}
												>
													{t(`plugins.resolution.${pkg.resolution}`)}
												</Badge>
												{updatableSources.has(pkg.source) && (
													<Badge variant="accent">{t("plugins.updateAvailable")}</Badge>
												)}
											</div>
											<p className="mt-0.5 truncate text-xs text-text-muted">{packageSummary(pkg, t)}</p>
										</div>
										{canExpand && (
											<ChevronDown
												className={`size-3.5 shrink-0 text-text-muted transition-transform motion-reduce:transition-none ${expanded ? "" : "-rotate-90"}`}
												aria-hidden="true"
											/>
										)}
									</button>
									<div className="ml-auto flex w-full shrink-0 flex-wrap justify-end gap-1 max-sm:[&_button]:flex-1 sm:w-auto">
										{updatableSources.has(pkg.source) && (
											<Button
												variant="outline"
												size="sm"
												disabled={busy}
												onClick={() => void update(pkg.source, pkg.scope)}
											>
												{t("plugins.update")}
											</Button>
										)}
										<Button
											variant="outline"
											size="sm"
											disabled={busy}
											onClick={() => setPendingRemove({ source: pkg.source, scope: pkg.scope })}
										>
											{t("plugins.remove")}
										</Button>
									</div>
								</div>
								{expanded && <PluginResourceGroups pkg={pkg} />}
							</div>
						);
					})
				)}
			</SettingsSection>

			{progressLog.length > 0 && (
				<SettingsSection title={t("plugins.activity")}>
					<div className="max-h-40 overflow-y-auto p-3 font-mono text-xs leading-relaxed text-text-muted">
						{progressLog.map((event, index) => (
							// eslint-disable-next-line react/no-array-index-key -- append-only log, index is a stable enough key here
							<div key={index}>
								[{event.type}] {event.action} {event.source} {event.message ?? ""}
							</div>
						))}
					</div>
				</SettingsSection>
			)}
			<Dialog
				open={pendingRemove !== null}
				onOpenChange={(open) => {
					if (!open) setPendingRemove(null);
				}}
			>
				{pendingRemove && (
					<DialogContent size="compact">
						<div className="flex flex-col gap-4">
							<DialogHeader>
								<DialogTitle>{t("plugins.confirmRemove", { source: pendingRemove.source })}</DialogTitle>
							</DialogHeader>
							<DialogFooter>
								<Button variant="outline" onClick={() => setPendingRemove(null)}>
									{t("plugins.cancel")}
								</Button>
								<Button
									variant="danger"
									onClick={() => {
										void remove(pendingRemove.source, pendingRemove.scope);
										setPendingRemove(null);
									}}
								>
									{t("plugins.remove")}
								</Button>
							</DialogFooter>
						</div>
					</DialogContent>
				)}
			</Dialog>
		</SettingsPage>
	);
}
