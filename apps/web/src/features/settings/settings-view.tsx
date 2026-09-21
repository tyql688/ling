import { useDomainApi } from "@renderer/lib/host-api-context";
import { UI_LANGUAGES, type AppSettingsUpdate } from "@ling/contracts/application";
import type { ComposerHistoryStatus } from "@ling/contracts/session";
import { errorMessage } from "@ling/contracts/ling-error";
import type { ShellNotificationPermission } from "@ling/contracts/api/shell-api";
import { DataHealthLink } from "@renderer/components/data-health/data-health";
import { Button } from "@renderer/components/ui/button";
import { Segmented } from "@renderer/components/ui/segmented";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@renderer/components/ui/select";
import { SettingsFieldRow, SettingsRow, SettingsSection } from "@renderer/components/ui/settings-list";
import { SettingsPage } from "@renderer/components/ui/settings-page";
import { Switch } from "@renderer/components/ui/switch";
import { showTodayUsageAtom } from "@renderer/features/usage/preferences";
import { languagePreferenceAtom } from "@renderer/i18n/index";
import type { FontSmoothingChoice, InterfaceZoomChoice } from "@renderer/lib/appearance/window-state";
import {
	FONT_SMOOTHING_CHOICES,
	fontSmoothingAtom,
	INTERFACE_ZOOM_CHOICES,
	interfaceZoomAtom,
} from "@renderer/lib/appearance/window-state";
import { useDataIssue } from "@renderer/lib/data-health/state";
import { datasetStoreIssue } from "@renderer/lib/dataset-status";
import { appPlatform, modEnter } from "@renderer/lib/platform";
import type { FollowUpBehavior, SendShortcut } from "@renderer/lib/preferences/composer";
import { composerEditorModeAtom, followUpBehaviorAtom, sendShortcutAtom } from "@renderer/lib/preferences/composer";

import { useAtom } from "jotai";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { RendererPreferencesResetRow } from "./renderer-preferences-reset-row";
import { SystemPermissionsSection, UpdateRow } from "./settings-system-rows";

type BooleanAppSettingType = Extract<AppSettingsUpdate, { enabled: boolean }>["type"];
type BooleanAppSettings = Record<BooleanAppSettingType, boolean | null>;

const BOOLEAN_APP_SETTING_TYPES = [
	"keepRunningOnWindowClose",
	"disableHardwareAcceleration",
	"notifyBackgroundCompletion",
	"fileMentionsRespectGitignore",
	"keepAwakeWhileRunning",
	"notifyAttentionNeeded",
	"playNotificationSounds",
] as const satisfies readonly BooleanAppSettingType[];

const UNLOADED_BOOLEAN_SETTINGS: BooleanAppSettings = Object.fromEntries(
	BOOLEAN_APP_SETTING_TYPES.map((type) => [type, null]),
) as BooleanAppSettings;

function readBooleanSettings(settings: Record<BooleanAppSettingType, boolean>): BooleanAppSettings {
	return Object.fromEntries(BOOLEAN_APP_SETTING_TYPES.map((type) => [type, settings[type]])) as BooleanAppSettings;
}

interface RowSelectProps {
	controlId: string;
	labelId: string;
	descriptionId: string | undefined;
	value: string;
	onChange: (value: string) => void;
	items: { value: string; label: string }[];
}

function RowSelect({ controlId, labelId, descriptionId, value, onChange, items }: RowSelectProps) {
	const current = items.find((item) => item.value === value);
	return (
		<Select value={value} onValueChange={(next) => next && onChange(next)}>
			<SelectTrigger id={controlId} aria-labelledby={labelId} aria-describedby={descriptionId} className="h-8">
				<SelectValue>{() => current?.label ?? ""}</SelectValue>
			</SelectTrigger>
			<SelectContent>
				{items.map((item) => (
					<SelectItem key={item.value} value={item.value}>
						{item.label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

/** Option order for send shortcuts; maps one-to-one to the SendShortcut union and its settings copy. */
const SEND_SHORTCUT_VALUES: SendShortcut[] = ["enter", "cmd-enter-multiline", "cmd-enter-always"];

/** Plain boolean app-setting row: null value means "not loaded yet" and disables the switch. */
function BooleanSettingRow({
	label,
	description,
	value,
	onChange,
}: {
	label: string;
	description: string;
	value: boolean | null;
	onChange: (checked: boolean) => void;
}) {
	return (
		<SettingsRow layout="toggle" label={label} description={description}>
			<Switch checked={value === true} disabled={value === null} onCheckedChange={onChange} aria-label={label} />
		</SettingsRow>
	);
}

export function SettingsView() {
	const hostUiApi = useDomainApi("ui");
	const hostAppApi = useDomainApi("app");
	const hostSessionApi = useDomainApi("session");

	const { t } = useTranslation();
	const capabilities = hostUiApi.capabilities;
	const [sendShortcut, setSendShortcut] = useAtom(sendShortcutAtom);
	const [composerEditorMode, setComposerEditorMode] = useAtom(composerEditorModeAtom);
	const [followUpBehavior, setFollowUpBehavior] = useAtom(followUpBehaviorAtom);
	const [booleanSettings, setBooleanSettings] = useState<BooleanAppSettings>(UNLOADED_BOOLEAN_SETTINGS);
	const [interfaceZoom, setInterfaceZoom] = useAtom(interfaceZoomAtom);
	const [fontSmoothing, setFontSmoothing] = useAtom(fontSmoothingAtom);
	const [showTodayUsage, setShowTodayUsage] = useAtom(showTodayUsageAtom);
	const [language, setLanguage] = useAtom(languagePreferenceAtom);
	const [appSettingsError, setAppSettingsError] = useState<string | null>(null);
	const [appSettingsRecoveryAllowed, setAppSettingsRecoveryAllowed] = useState(false);

	const [composerHistoryStatus, setComposerHistoryStatus] = useState<ComposerHistoryStatus | null>(null);
	const [composerHistoryState, setComposerHistoryState] = useState<
		"idle" | "retrying" | "recovered" | "clearing" | "cleared" | "error"
	>("idle");
	const [composerHistoryError, setComposerHistoryError] = useState<string | null>(null);
	const [notificationPermission, setNotificationPermission] = useState<ShellNotificationPermission | null>(null);
	const [notificationPermissionError, setNotificationPermissionError] = useState<string | null>(null);

	const loadAppSettings = useCallback(
		async (cancelled: () => boolean = () => false): Promise<void> => {
			const result = await hostAppApi.getSettings();
			if (cancelled()) return;
			if (result.status !== "ready") {
				const issue = datasetStoreIssue(result, (key, options) => (options === undefined ? t(key) : t(key, options)));
				if (!issue) throw new Error("Dataset issue projection is missing");
				setBooleanSettings(UNLOADED_BOOLEAN_SETTINGS);
				setAppSettingsError(issue.message);
				setAppSettingsRecoveryAllowed(issue.recoverable);
				return;
			}
			setBooleanSettings(readBooleanSettings(result.settings));
			setAppSettingsError(null);
			setAppSettingsRecoveryAllowed(false);
		},
		[hostAppApi, t],
	);

	useEffect(() => {
		let cancelled = false;
		void loadAppSettings(() => cancelled).catch((error: unknown) => {
			if (!cancelled) setAppSettingsError(errorMessage(error));
		});
		return () => {
			cancelled = true;
		};
	}, [loadAppSettings]);

	useEffect(() => {
		let cancelled = false;
		void hostSessionApi
			.composerHistoryStatus()
			.then((status) => {
				if (!cancelled) setComposerHistoryStatus(status);
			})
			.catch((error: unknown) => {
				if (!cancelled) setComposerHistoryError(errorMessage(error));
			});
		return () => {
			cancelled = true;
		};
	}, [hostSessionApi]);

	useEffect(() => {
		if (!capabilities.notificationPermissionRequest) return;
		let cancelled = false;
		void hostAppApi
			.getNotificationPermission()
			.then((permission) => {
				if (!cancelled) setNotificationPermission(permission);
			})
			.catch((error: unknown) => {
				if (!cancelled) setNotificationPermissionError(errorMessage(error));
			});
		return () => {
			cancelled = true;
		};
	}, [hostAppApi, capabilities.notificationPermissionRequest]);

	/** One optimistic-update path for every boolean app setting: apply locally, persist,
	 * adopt the authoritative value, revert on failure. */
	const updateBooleanSetting = (type: BooleanAppSettingType, checked: boolean) => {
		const current = booleanSettings[type];
		const apply = (value: boolean | null) => setBooleanSettings((all) => ({ ...all, [type]: value }));
		apply(checked);
		void hostAppApi
			.updateSettings({ type, enabled: checked })
			.then((settings) => {
				apply(settings[type]);
				setAppSettingsError(null);
				setAppSettingsRecoveryAllowed(false);
			})
			.catch((error: unknown) => {
				apply(current);
				setAppSettingsError(errorMessage(error));
			});
	};

	const requestNotificationPermission = () => {
		setNotificationPermissionError(null);
		void hostAppApi
			.requestNotificationPermission()
			.then(setNotificationPermission)
			.catch((error: unknown) => setNotificationPermissionError(errorMessage(error)));
	};

	const resetAppSettings = async () => {
		await hostAppApi
			.resetSettings()
			.then((settings) => {
				setBooleanSettings(readBooleanSettings(settings));
				setAppSettingsError(null);
			})
			.catch((error: unknown) => setAppSettingsError(errorMessage(error)));
	};

	const clearComposerHistory = () => {
		setComposerHistoryState("clearing");
		setComposerHistoryError(null);
		void hostSessionApi
			.clearComposerHistory()
			.then((status) => {
				setComposerHistoryStatus(status);
				setComposerHistoryState(status.status === "ready" ? "cleared" : "idle");
			})
			.catch((error: unknown) => {
				setComposerHistoryState("error");
				setComposerHistoryError(errorMessage(error));
			});
	};

	const retryComposerHistory = async () => {
		setComposerHistoryState("retrying");
		setComposerHistoryError(null);
		await hostSessionApi
			.retryComposerHistory()
			.then((status) => {
				setComposerHistoryStatus(status);
				setComposerHistoryState(status.status === "ready" ? "recovered" : "idle");
			})
			.catch((error: unknown) => {
				setComposerHistoryState("error");
				setComposerHistoryError(errorMessage(error));
			});
	};

	useDataIssue(
		"ling/app-settings",
		appSettingsError
			? {
					label: t("settings.appSettings"),
					message: appSettingsError,
					retry: loadAppSettings,
					...(appSettingsRecoveryAllowed
						? {
								recovery: {
									label: t("settings.appSettingsReset"),
									description: t("settings.appSettingsReadError", { message: appSettingsError }),
									run: resetAppSettings,
								},
							}
						: {}),
				}
			: null,
	);
	useDataIssue(
		"ling/composer-history",
		composerHistoryError || composerHistoryStatus?.status === "degraded"
			? {
					label: t("settings.clearComposerHistory"),
					message:
						composerHistoryError ??
						t("settings.composerHistoryDegraded", { count: composerHistoryStatus?.pendingEntries }),
					retry: retryComposerHistory,
				}
			: null,
	);

	return (
		// Project management lives in the sidebar (right-click a project group) — the settings
		// page only carries app-level preferences.
		<SettingsPage title={t("settings.general")}>
			<SettingsSection title={t("settings.appBehavior")}>
				{appSettingsError && (
					<SettingsRow
						label={t("settings.appSettings")}
						description={t(
							appSettingsRecoveryAllowed ? "settings.appSettingsReadError" : "settings.appSettingsUnavailable",
							{
								message: appSettingsError,
							},
						)}
					>
						<DataHealthLink />
					</SettingsRow>
				)}
				{capabilities.windowClosePersistence && (
					<BooleanSettingRow
						label={t("settings.keepRunningOnWindowClose")}
						description={t("settings.keepRunningOnWindowCloseDescription")}
						value={booleanSettings.keepRunningOnWindowClose}
						onChange={(checked) => updateBooleanSetting("keepRunningOnWindowClose", checked)}
					/>
				)}
				{capabilities.hardwareAccelerationControl && (
					<BooleanSettingRow
						label={t("settings.disableHardwareAcceleration")}
						description={t("settings.disableHardwareAccelerationDescription")}
						value={booleanSettings.disableHardwareAcceleration}
						onChange={(checked) => updateBooleanSetting("disableHardwareAcceleration", checked)}
					/>
				)}
				<BooleanSettingRow
					label={t("settings.fileMentionsRespectGitignore")}
					description={t("settings.fileMentionsRespectGitignoreDescription")}
					value={booleanSettings.fileMentionsRespectGitignore}
					onChange={(checked) => updateBooleanSetting("fileMentionsRespectGitignore", checked)}
				/>
				{capabilities.screenWakeLock && (
					<BooleanSettingRow
						label={t("settings.keepAwakeWhileRunning")}
						description={t("settings.keepAwakeWhileRunningDescription")}
						value={booleanSettings.keepAwakeWhileRunning}
						onChange={(checked) => updateBooleanSetting("keepAwakeWhileRunning", checked)}
					/>
				)}
			</SettingsSection>

			{capabilities.nativeNotifications && (
				<SettingsSection title={t("settings.notifications")}>
					<BooleanSettingRow
						label={t("settings.notifyBackgroundCompletion")}
						description={t("settings.notifyBackgroundCompletionDescription")}
						value={booleanSettings.notifyBackgroundCompletion}
						onChange={(checked) => updateBooleanSetting("notifyBackgroundCompletion", checked)}
					/>
					<BooleanSettingRow
						label={t("settings.notifyAttentionNeeded")}
						description={t("settings.notifyAttentionNeededDescription")}
						value={booleanSettings.notifyAttentionNeeded}
						onChange={(checked) => updateBooleanSetting("notifyAttentionNeeded", checked)}
					/>
					<BooleanSettingRow
						label={t("settings.playNotificationSounds")}
						description={t("settings.playNotificationSoundsDescription")}
						value={booleanSettings.playNotificationSounds}
						onChange={(checked) => updateBooleanSetting("playNotificationSounds", checked)}
					/>
					{capabilities.notificationPermissionRequest && (
						<SettingsRow
							label={t("settings.browserNotificationPermission")}
							description={
								notificationPermissionError ??
								t(`settings.systemPermissionStatus_${notificationPermission ?? "unknown"}`)
							}
						>
							{notificationPermission !== "granted" && (
								<Button variant="outline" size="sm" onClick={requestNotificationPermission}>
									{t("settings.browserNotificationPermissionRequest")}
								</Button>
							)}
						</SettingsRow>
					)}
					{capabilities.systemPermissions && (appPlatform === "darwin" || appPlatform === "win32") && (
						<SettingsRow
							label={t("settings.systemNotificationSettings")}
							description={t("settings.systemNotificationSettingsDescription")}
						>
							<Button
								variant="outline"
								size="sm"
								onClick={() =>
									void hostAppApi.openSystemPermission(
										appPlatform === "darwin" ? "mac-notifications" : "windows-notifications",
									)
								}
							>
								{t("settings.systemNotificationSettingsOpen")}
							</Button>
						</SettingsRow>
					)}
				</SettingsSection>
			)}

			<SettingsSection>
				<SettingsFieldRow label={t("settings.language")}>
					{({ controlId, labelId, descriptionId }) => (
						<RowSelect
							controlId={controlId}
							labelId={labelId}
							descriptionId={descriptionId}
							value={language}
							onChange={(value) => setLanguage(value as (typeof UI_LANGUAGES)[number])}
							items={UI_LANGUAGES.map((lng) => ({ value: lng, label: t(`languages.${lng}`) }))}
						/>
					)}
				</SettingsFieldRow>
				<SettingsFieldRow label={t("settings.interfaceZoom")}>
					{({ controlId, labelId, descriptionId }) => (
						<RowSelect
							controlId={controlId}
							labelId={labelId}
							descriptionId={descriptionId}
							value={interfaceZoom}
							onChange={(value) => setInterfaceZoom(value as InterfaceZoomChoice)}
							items={INTERFACE_ZOOM_CHOICES.map((choice) => ({ value: choice, label: `${choice}%` }))}
						/>
					)}
				</SettingsFieldRow>
				<SettingsFieldRow label={t("settings.fontSmoothing")} description={t("settings.fontSmoothingDescription")}>
					{({ controlId, labelId, descriptionId }) => (
						<RowSelect
							controlId={controlId}
							labelId={labelId}
							descriptionId={descriptionId}
							value={fontSmoothing}
							onChange={(value) => setFontSmoothing(value as FontSmoothingChoice)}
							items={FONT_SMOOTHING_CHOICES.map((choice) => ({
								value: choice,
								label: t(`settings.fontSmoothing_${choice}`),
							}))}
						/>
					)}
				</SettingsFieldRow>
				<SettingsRow
					layout="toggle"
					label={t("settings.showTodayUsage")}
					description={t("settings.showTodayUsageDescription")}
				>
					<Switch
						checked={showTodayUsage}
						onCheckedChange={setShowTodayUsage}
						aria-label={t("settings.showTodayUsage")}
					/>
				</SettingsRow>
			</SettingsSection>

			<SystemPermissionsSection />

			<SettingsSection title={t("settings.data")}>
				<SettingsRow label={t("data.title")} description={t("data.description")}>
					<DataHealthLink />
				</SettingsRow>
				<RendererPreferencesResetRow />
				<SettingsRow
					label={t("settings.clearComposerHistory")}
					description={
						composerHistoryError ??
						(composerHistoryStatus?.status === "degraded"
							? t("settings.composerHistoryDegraded", { count: composerHistoryStatus.pendingEntries })
							: composerHistoryState === "cleared"
								? t("settings.clearComposerHistoryCleared")
								: composerHistoryState === "recovered"
									? t("settings.composerHistoryRecovered")
									: t("settings.clearComposerHistoryDescription"))
					}
				>
					<div className="flex gap-2">
						<Button
							variant="outline"
							size="sm"
							disabled={composerHistoryState === "clearing" || composerHistoryState === "retrying"}
							onClick={clearComposerHistory}
						>
							{composerHistoryState === "clearing"
								? t("settings.clearComposerHistoryClearing")
								: t("settings.clearComposerHistoryAction")}
						</Button>
					</div>
				</SettingsRow>
			</SettingsSection>

			<SettingsSection title={t("settings.editor")}>
				<SettingsRow
					layout="toggle"
					label={t("settings.markdownComposer")}
					description={t("settings.markdownComposerDescription")}
				>
					<Switch
						checked={composerEditorMode === "markdown"}
						onCheckedChange={(checked) => setComposerEditorMode(checked ? "markdown" : "plain")}
						aria-label={t("settings.markdownComposer")}
					/>
				</SettingsRow>
				<SettingsFieldRow label={t("settings.sendShortcut")}>
					{({ controlId, labelId, descriptionId }) => (
						<RowSelect
							controlId={controlId}
							labelId={labelId}
							descriptionId={descriptionId}
							value={sendShortcut}
							onChange={(value) => setSendShortcut(value as SendShortcut)}
							items={SEND_SHORTCUT_VALUES.map((value) => ({
								value,
								label: t(`settings.sendShortcut_${value}`, { modEnter }),
							}))}
						/>
					)}
				</SettingsFieldRow>
				<SettingsFieldRow
					group
					label={t("settings.followUp")}
					description={t("settings.followUpDescription", { modEnter })}
				>
					{({ labelId, descriptionId }) => (
						<Segmented<FollowUpBehavior>
							value={followUpBehavior}
							onChange={setFollowUpBehavior}
							options={[
								{ value: "queue", label: t("settings.followUp_queue") },
								{ value: "steer", label: t("settings.followUp_steer") },
							]}
							ariaLabelledBy={labelId}
							ariaDescribedBy={descriptionId}
						/>
					)}
				</SettingsFieldRow>
			</SettingsSection>

			<SettingsSection title={t("settings.about")}>
				<UpdateRow />
			</SettingsSection>
		</SettingsPage>
	);
}
