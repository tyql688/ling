import { useDomainApi } from "@renderer/lib/host-api-context";
import type { PiResourceReloadSummary } from "@ling/contracts/session";
import type { SkillsOverview, SkillUpdateStatus } from "@ling/contracts/skill";
import { ResourceReloadFeedback } from "@renderer/components/resource-reload-feedback";
import { Button } from "@renderer/components/ui/button";
import { FeedbackNotice } from "@renderer/components/ui/feedback";
import { LoadingTransition } from "@renderer/components/ui/loading-transition";
import { SettingsRow, SettingsSection } from "@renderer/components/ui/settings-list";
import { SettingsPage } from "@renderer/components/ui/settings-page";
import { SettingsRetryAction, SettingsState } from "@renderer/components/ui/settings-state";
import { Switch } from "@renderer/components/ui/switch";
import { formatRequestError } from "@renderer/lib/errors";
import { tildify } from "@renderer/lib/format-path";
import { createRequestFence, type RequestFence } from "@renderer/lib/request-fence";
import { DownloadCloud, FolderOpen, FolderPlus, GraduationCap, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { SkillBrowser } from "./skill-browser";
import { SkillDetailDialog } from "./skill-detail-view";
import { useSkillDetail } from "./use-skill-detail";

const SKILLS_OVERVIEW_IDENTITY = "skills-overview";

/**
 * Settings surface for skills Pi shares across projects: global directories, the
 * settings-configured extra directories, and skills shipped inside packages.
 * Project-scoped skills deliberately do not appear here — they belong to their
 * project and are browsable from the workspace Skills control.
 */
export function SkillsView() {
	const hostSkillsApi = useDomainApi("skills");
	const hostPiSettingsApi = useDomainApi("piSettings");
	const hostUiApi = useDomainApi("ui");

	const { t } = useTranslation();
	const [overview, setOverview] = useState<SkillsOverview | null>(null);
	const [overviewLoading, setOverviewLoading] = useState(true);
	const [reloading, setReloading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [togglingCommands, setTogglingCommands] = useState(false);
	const [mutatingPaths, setMutatingPaths] = useState(false);
	const [reloadSummary, setReloadSummary] = useState<PiResourceReloadSummary | null>(null);
	const [updateStatuses, setUpdateStatuses] = useState<SkillUpdateStatus[] | null>(null);
	const [checkingUpdates, setCheckingUpdates] = useState(false);
	const [updatingSkills, setUpdatingSkills] = useState(false);
	const [updateOutput, setUpdateOutput] = useState<string | null>(null);
	const { detail, openDetail, selectResource, retryDetail, retryResource, closeDetail } = useSkillDetail();
	const overviewFenceRef = useRef<RequestFence<typeof SKILLS_OVERVIEW_IDENTITY> | null>(null);
	overviewFenceRef.current ??= createRequestFence<typeof SKILLS_OVERVIEW_IDENTITY>();
	const overviewFence = overviewFenceRef.current;
	const updateCheckRevisionRef = useRef(0);
	const mountedRef = useRef(true);
	const loading = overviewLoading || reloading;
	const controlsBusy = loading || togglingCommands || mutatingPaths || checkingUpdates || updatingSkills;

	const refresh = useCallback(async () => {
		if (!mountedRef.current) return;
		const request = overviewFence.begin(SKILLS_OVERVIEW_IDENTITY);
		setOverviewLoading(true);
		try {
			const next = await hostSkillsApi.overview();
			if (!mountedRef.current || !overviewFence.isCurrent(request, SKILLS_OVERVIEW_IDENTITY)) return;
			setOverview(next);
			setError(null);
		} catch (cause) {
			if (!mountedRef.current || !overviewFence.isCurrent(request, SKILLS_OVERVIEW_IDENTITY)) return;
			setError(formatRequestError(cause));
		} finally {
			if (mountedRef.current && overviewFence.isCurrent(request, SKILLS_OVERVIEW_IDENTITY)) {
				setOverviewLoading(false);
			}
		}
	}, [hostSkillsApi, overviewFence]);

	useEffect(() => {
		mountedRef.current = true;
		void refresh();
		return () => {
			mountedRef.current = false;
			overviewFence.invalidate();
			updateCheckRevisionRef.current += 1;
		};
	}, [overviewFence, refresh]);

	const reload = useCallback(async () => {
		setReloading(true);
		setReloadSummary(null);
		let reloadError: unknown = null;
		try {
			const summary = await hostSkillsApi.reload();
			if (mountedRef.current) setReloadSummary(summary);
		} catch (cause) {
			reloadError = cause;
		} finally {
			await refresh();
			if (mountedRef.current) {
				if (reloadError !== null) setError(formatRequestError(reloadError));
				setReloading(false);
			}
		}
	}, [hostSkillsApi, refresh]);

	const reportError = useCallback((cause: unknown) => {
		if (mountedRef.current) setError(formatRequestError(cause));
	}, []);

	const builtinSkills = useMemo(() => (overview?.skills ?? []).filter((skill) => skill.builtin), [overview]);
	const globalSkills = useMemo(
		() =>
			(overview?.skills ?? []).filter(
				(skill) => skill.scope !== "project" && skill.origin !== "package" && !skill.builtin,
			),
		[overview],
	);
	const packageSkills = useMemo(
		() => (overview?.skills ?? []).filter((skill) => skill.scope !== "project" && skill.origin === "package"),
		[overview],
	);

	const toggleSkillCommands = (enabled: boolean) => {
		setTogglingCommands(true);
		setReloadSummary(null);
		void (async () => {
			let mutationError: unknown = null;
			try {
				await hostPiSettingsApi.update({ type: "enableSkillCommands", enabled });
			} catch (cause) {
				mutationError = cause;
			} finally {
				// The setting may already be on disk even when live reload rejects.
				await refresh();
				if (mountedRef.current) {
					if (mutationError !== null) reportError(mutationError);
					setTogglingCommands(false);
				}
			}
		})();
	};

	const runPathMutation = (mutate: () => Promise<{ reload: PiResourceReloadSummary } | null>): void => {
		setMutatingPaths(true);
		setReloadSummary(null);
		void (async () => {
			let mutationError: unknown = null;
			try {
				const result = await mutate();
				if (result && mountedRef.current) setReloadSummary(result.reload);
			} catch (cause) {
				mutationError = cause;
			} finally {
				// Package/settings operations may partially publish before failing.
				await refresh();
				if (mountedRef.current) {
					if (mutationError !== null) reportError(mutationError);
					setMutatingPaths(false);
				}
			}
		})();
	};

	const checkUpdates = useCallback(async () => {
		if (!mountedRef.current) return;
		updateCheckRevisionRef.current += 1;
		const revision = updateCheckRevisionRef.current;
		setCheckingUpdates(true);
		setUpdateOutput(null);
		try {
			const next = await hostSkillsApi.checkUpdates();
			if (mountedRef.current && revision === updateCheckRevisionRef.current) setUpdateStatuses(next);
		} catch (cause) {
			if (mountedRef.current && revision === updateCheckRevisionRef.current) reportError(cause);
		} finally {
			if (mountedRef.current && revision === updateCheckRevisionRef.current) setCheckingUpdates(false);
		}
	}, [hostSkillsApi, reportError]);

	const runUpdates = useCallback(
		async (names: string[]) => {
			updateCheckRevisionRef.current += 1;
			setCheckingUpdates(false);
			setUpdatingSkills(true);
			setUpdateOutput(null);
			setReloadSummary(null);
			let updateError: unknown = null;
			try {
				const result = await hostSkillsApi.runUpdates({ names });
				if (mountedRef.current) {
					setUpdateOutput(result.output.trim());
					setReloadSummary(result.reload);
				}
			} catch (cause) {
				updateError = cause;
			} finally {
				await Promise.all([refresh(), checkUpdates()]);
				if (mountedRef.current) {
					if (updateError !== null) reportError(updateError);
					setUpdatingSkills(false);
				}
			}
		},
		[hostSkillsApi, checkUpdates, refresh, reportError],
	);

	const availableUpdates = useMemo(
		() => (updateStatuses ?? []).filter((status) => status.status === "update-available"),
		[updateStatuses],
	);
	const uncheckedUpdates = useMemo(
		() => (updateStatuses ?? []).filter((status) => status.status === "unknown" || status.status === "error"),
		[updateStatuses],
	);

	const addPath = () => {
		runPathMutation(() => hostSkillsApi.addPath());
	};

	const removePath = (path: string) => {
		runPathMutation(() => hostSkillsApi.removePath({ path }));
	};

	return (
		<SettingsPage
			title={t("skills.title")}
			description={t("skills.description")}
			actions={
				<>
					{hostUiApi.capabilities.nativePathOpen && (
						<Button variant="outline" size="sm" onClick={() => void hostSkillsApi.openGlobalDir().catch(reportError)}>
							<FolderOpen className="size-3.5" aria-hidden="true" />
							{t("skills.openGlobalDir")}
						</Button>
					)}
					{availableUpdates.length > 0 && (
						<Button
							variant="outline"
							size="sm"
							disabled={controlsBusy}
							onClick={() => void runUpdates(availableUpdates.map((status) => status.name))}
						>
							<DownloadCloud className="size-3.5" aria-hidden="true" />
							{updatingSkills ? t("skills.updating") : t("skills.updateAllCount", { count: availableUpdates.length })}
						</Button>
					)}
					<Button variant="outline" size="sm" disabled={controlsBusy} onClick={() => void checkUpdates()}>
						<DownloadCloud className={`size-3.5 ${checkingUpdates ? "animate-pulse" : ""}`} aria-hidden="true" />
						{checkingUpdates ? t("skills.checkingUpdates") : t("skills.checkUpdates")}
					</Button>
					<Button variant="outline" size="sm" disabled={controlsBusy} onClick={() => void reload()}>
						<RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} aria-hidden="true" />
						{t("skills.reload")}
					</Button>
				</>
			}
		>
			{error && overview !== null && (
				<FeedbackNotice
					tone="danger"
					title={t("skills.loadFailed")}
					action={<SettingsRetryAction label={t("skills.retry")} onClick={() => void refresh()} />}
				>
					{error}
				</FeedbackNotice>
			)}
			{reloadSummary && <ResourceReloadFeedback summary={reloadSummary} />}
			{updateStatuses !== null && (
				<FeedbackNotice tone="info" title={t("skills.updates")} className="text-xs">
					{availableUpdates.length === 0 && uncheckedUpdates.length === 0 ? (
						<p>{t("skills.updatesNone")}</p>
					) : (
						<div className="flex flex-col gap-1">
							{availableUpdates.map((status) => (
								<div key={status.name} className="flex items-center gap-2">
									<span className="min-w-0 flex-1 truncate">
										{status.name}
										<span className="ml-2 font-mono text-text-muted">{status.source}</span>
										{status.dirty && <span className="ml-2 text-warning">{t("skills.updateDirty")}</span>}
									</span>
									<Button
										variant="ghost"
										size="sm"
										className="shrink-0"
										disabled={controlsBusy}
										onClick={() => void runUpdates([status.name])}
									>
										{t("skills.updateOne")}
									</Button>
								</div>
							))}
						</div>
					)}
					{uncheckedUpdates.length > 0 && (
						<p
							className="mt-1 text-text-muted"
							title={uncheckedUpdates
								.map((status) => `${status.name}: ${status.reason ?? t("skills.updateCheckFailed")}`)
								.join("\n")}
						>
							{t("skills.updatesUnchecked", { count: uncheckedUpdates.length })}
						</p>
					)}
					{updateOutput && (
						<details className="mt-1 text-text-muted">
							<summary className="cursor-pointer">{t("skills.updateOutput")}</summary>
							<pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap font-mono text-xs">{updateOutput}</pre>
						</details>
					)}
				</FeedbackNotice>
			)}

			{overview === null ? (
				error ? (
					<SettingsState
						icon={GraduationCap}
						title={t("skills.loadFailed")}
						description={error}
						tone="danger"
						action={<SettingsRetryAction label={t("skills.retry")} onClick={() => void refresh()} />}
					/>
				) : (
					<LoadingTransition label={t("skills.loading")} />
				)
			) : (
				<>
					<SettingsSection>
						<SettingsRow
							layout="toggle"
							label={t("skills.commandsToggle")}
							description={t("skills.commandsToggleDescription")}
						>
							<Switch
								aria-label={t("skills.commandsToggle")}
								checked={overview.enableSkillCommands}
								disabled={controlsBusy}
								onCheckedChange={toggleSkillCommands}
							/>
						</SettingsRow>
					</SettingsSection>

					<SkillBrowser
						groups={[
							{
								key: "builtin",
								title: t("skills.builtinTitle"),
								skills: builtinSkills,
								action: (
									<Switch
										aria-label={t("skills.builtinMaster")}
										title={t("skills.builtinMasterDescription")}
										checked={overview.builtinSkillsEnabled}
										disabled={controlsBusy}
										onCheckedChange={(enabled) => runPathMutation(() => hostSkillsApi.setBuiltinEnabled({ enabled }))}
									/>
								),
								togglesDisabled: !overview.builtinSkillsEnabled,
								flat: true,
							},
							{
								key: "global",
								title: t("skills.sectionGlobal"),
								skills: globalSkills,
								emptyTitle: t("skills.emptyGlobalTitle"),
								emptyDescription: t("skills.emptyGlobal"),
							},
							{ key: "packages", title: t("skills.sectionPackages"), skills: packageSkills },
						]}
						roots={[overview.globalSkillsDir, ...overview.extraPaths]}
						onSelect={openDetail}
						toggle={{
							onToggle: (skill, enabled) =>
								runPathMutation(() => hostSkillsApi.setSkillEnabled({ name: skill.name, enabled })),
							busy: controlsBusy,
						}}
					/>

					<SettingsSection
						title={t("skills.extraPaths")}
						action={
							<Button variant="outline" size="sm" disabled={controlsBusy} onClick={addPath}>
								<FolderPlus className="size-3.5" aria-hidden="true" />
								{t("skills.addPath")}
							</Button>
						}
					>
						{overview.extraPaths.length === 0 ? (
							<p className="px-4 py-3 text-xs leading-relaxed text-text-muted">{t("skills.extraPathsHint")}</p>
						) : (
							overview.extraPaths.map((path) => (
								<div key={path} className="flex items-center gap-3 px-4 py-2.5">
									<code className="min-w-0 flex-1 truncate font-mono text-xs text-text-muted">{tildify(path)}</code>
									<Button
										variant="ghost"
										size="sm"
										className="shrink-0"
										disabled={controlsBusy}
										onClick={() => removePath(path)}
									>
										{t("skills.removePath")}
									</Button>
								</div>
							))
						)}
					</SettingsSection>

					{overview.diagnostics.length > 0 && (
						<SettingsSection title={t("skills.diagnostics")}>
							<div className="flex flex-col gap-2 px-4 py-3">
								{overview.diagnostics.map((diagnostic) => (
									<FeedbackNotice
										key={`${diagnostic.type}:${diagnostic.message}:${diagnostic.path ?? ""}`}
										tone={diagnostic.type === "error" ? "danger" : diagnostic.type === "collision" ? "info" : "warning"}
										className="text-xs"
									>
										<p>{diagnostic.message}</p>
										{diagnostic.path && (
											<p className="mt-0.5 truncate text-text-muted/70">{tildify(diagnostic.path)}</p>
										)}
									</FeedbackNotice>
								))}
							</div>
						</SettingsSection>
					)}
				</>
			)}

			<SkillDetailDialog
				detail={detail}
				onClose={closeDetail}
				onRetry={retryDetail}
				onSelectResource={selectResource}
				onRetryResource={retryResource}
				onError={reportError}
			/>
		</SettingsPage>
	);
}
