import { TerminalTypographySettings } from "./terminal-typography-settings";
import { useDomainApi } from "@renderer/lib/host-api-context";
import type { AppSettingsSnapshot, AppSettingsUpdate } from "@ling/contracts/application";
import type { ProjectLaunchTarget, ProjectLaunchTargetId, ProjectLaunchTargetKind } from "@ling/contracts/project";
import type { TerminalProfile } from "@ling/contracts/terminal";
import { errorMessage } from "@ling/contracts/ling-error";
import { FeedbackNotice } from "@renderer/components/ui/feedback";
import { LoadingTransition } from "@renderer/components/ui/loading-transition";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@renderer/components/ui/select";
import { SettingsFieldRow, SettingsSection } from "@renderer/components/ui/settings-list";
import { SettingsPage } from "@renderer/components/ui/settings-page";
import { SettingsRetryAction, SettingsState } from "@renderer/components/ui/settings-state";
import { datasetStoreIssue } from "@renderer/lib/dataset-status";
import { SquareTerminal } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

/** Select sentinel value: means follow-the-system / auto-detect, not a real profile id (ids may contain special characters). */
const AUTOMATIC_VALUE = "__automatic__";

interface PreferenceOption {
	value: string;
	label: string;
	description?: string | undefined;
}

function PreferenceSelect({
	value,
	options,
	disabled,
	onChange,
	controlId,
	labelId,
	descriptionId,
}: {
	value: string;
	options: PreferenceOption[];
	disabled: boolean;
	onChange: (value: string) => void;
	controlId: string;
	labelId: string;
	descriptionId: string | undefined;
}) {
	const current = options.find((option) => option.value === value);
	return (
		<Select value={value} disabled={disabled} onValueChange={(next) => next && onChange(next)}>
			<SelectTrigger
				id={controlId}
				aria-labelledby={labelId}
				aria-describedby={descriptionId}
				className="h-8 min-w-52 max-w-80"
			>
				<SelectValue>{() => current?.label ?? value}</SelectValue>
			</SelectTrigger>
			<SelectContent>
				{options.map((option) => (
					<SelectItem key={option.value} value={option.value}>
						<span className="block min-w-0">
							<span className="block truncate">{option.label}</span>
							{option.description && (
								<span className="block truncate text-xs text-text-muted">{option.description}</span>
							)}
						</span>
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

function launcherOptions(
	kind: ProjectLaunchTargetKind,
	targets: readonly ProjectLaunchTarget[],
	selected: ProjectLaunchTargetId | null,
	automaticLabel: string,
	unavailableLabel: (id: string) => string,
): PreferenceOption[] {
	const available = targets.filter((target) => target.kind === kind);
	const options: PreferenceOption[] = [
		{
			value: AUTOMATIC_VALUE,
			label: available[0] ? `${automaticLabel} · ${available[0].name}` : automaticLabel,
		},
		...available.map((target) => ({ value: target.id, label: target.name })),
	];
	if (selected !== null && !available.some((target) => target.id === selected)) {
		options.push({ value: selected, label: unavailableLabel(selected) });
	}
	return options;
}

function profileOptions(
	profiles: readonly TerminalProfile[],
	suggestedProfileId: string | null,
	selected: string | null,
	automaticLabel: string,
	unavailableLabel: (id: string) => string,
): PreferenceOption[] {
	const suggested = profiles.find((profile) => profile.id === suggestedProfileId);
	const options: PreferenceOption[] = [
		{
			value: AUTOMATIC_VALUE,
			label: suggested ? `${automaticLabel} · ${suggested.name}` : automaticLabel,
		},
		...profiles.map((profile) => ({ value: profile.id, label: profile.name, description: profile.path })),
	];
	if (selected !== null && !profiles.some((profile) => profile.id === selected)) {
		options.push({ value: selected, label: unavailableLabel(selected) });
	}
	return options;
}

export function TerminalSettingsView() {
	const hostAppApi = useDomainApi("app");
	const hostProjectApi = useDomainApi("project");
	const hostTerminalApi = useDomainApi("terminal");

	const { t } = useTranslation();
	const [settings, setSettings] = useState<AppSettingsSnapshot | null>(null);
	const [targets, setTargets] = useState<ProjectLaunchTarget[]>([]);
	const [profiles, setProfiles] = useState<TerminalProfile[]>([]);
	const [suggestedProfileId, setSuggestedProfileId] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [loadError, setLoadError] = useState<string | null>(null);
	const loadVersionRef = useRef(0);
	const saveInFlightRef = useRef(false);

	const load = useCallback(async () => {
		const version = ++loadVersionRef.current;
		try {
			const [settingsResult, nextTargets, terminalProfiles] = await Promise.all([
				hostAppApi.getSettings(),
				hostProjectApi.listLaunchTargets(),
				hostTerminalApi.listProfiles(),
			]);
			if (settingsResult.status !== "ready") {
				const issue = datasetStoreIssue(settingsResult, (key, options) =>
					options === undefined ? t(key) : t(key, options),
				);
				throw new Error(issue?.message ?? "App settings are unavailable.");
			}
			if (loadVersionRef.current !== version) return;
			setSettings(settingsResult.settings);
			setTargets(nextTargets);
			setProfiles(terminalProfiles.profiles);
			setSuggestedProfileId(terminalProfiles.suggestedProfileId);
			setLoadError(null);
		} catch (error) {
			if (loadVersionRef.current === version) setLoadError(errorMessage(error));
		}
	}, [hostAppApi, hostProjectApi, hostTerminalApi, t]);

	useEffect(() => {
		void load();
		return () => {
			loadVersionRef.current += 1;
		};
	}, [load]);

	const automaticLabel = t("settings.launcherAutomatic");
	const unavailableLabel = (id: string) => t("settings.launcherUnavailable", { id });
	const editorOptions = launcherOptions(
		"editor",
		targets,
		settings?.projectLaunchers.editor ?? null,
		automaticLabel,
		unavailableLabel,
	);
	const terminalOptions = launcherOptions(
		"terminal",
		targets,
		settings?.projectLaunchers.terminal ?? null,
		automaticLabel,
		unavailableLabel,
	);
	const fileManagerOptions = launcherOptions(
		"file-manager",
		targets,
		settings?.projectLaunchers["file-manager"] ?? null,
		automaticLabel,
		unavailableLabel,
	);
	const integratedProfileOptions = profileOptions(
		profiles,
		suggestedProfileId,
		settings?.integratedTerminalProfileId ?? null,
		automaticLabel,
		unavailableLabel,
	);

	const persistUpdate = (update: AppSettingsUpdate) => {
		if (!settings || saveInFlightRef.current) return;
		saveInFlightRef.current = true;
		setSaving(true);
		void hostAppApi
			.updateSettings(update)
			.then((next) => {
				setSettings(next);
				setLoadError(null);
			})
			.catch((error: unknown) => setLoadError(errorMessage(error)))
			.finally(() => {
				saveInFlightRef.current = false;
				setSaving(false);
			});
	};

	const updateLauncher = (kind: ProjectLaunchTargetKind, value: string) => {
		const targetId = value === AUTOMATIC_VALUE ? null : (value as ProjectLaunchTargetId);
		persistUpdate({ type: "projectLauncher", kind, targetId });
	};

	const updateProfile = (value: string) => {
		persistUpdate({
			type: "integratedTerminalProfile",
			profileId: value === AUTOMATIC_VALUE ? null : value,
		});
	};

	const disabled = settings === null || saving;
	return (
		<SettingsPage title={t("settings.terminal")}>
			{settings === null ? (
				loadError ? (
					<SettingsState
						icon={SquareTerminal}
						title={t("settings.terminalLoadFailed")}
						description={loadError}
						tone="danger"
						action={<SettingsRetryAction label={t("settings.appSettingsRetry")} onClick={() => void load()} />}
					/>
				) : (
					<LoadingTransition label={t("settings.terminalLoading")} />
				)
			) : (
				<>
					{loadError && (
						<FeedbackNotice
							tone="danger"
							title={t("settings.terminalLoadFailed")}
							action={<SettingsRetryAction label={t("settings.appSettingsRetry")} onClick={() => void load()} />}
							className="mb-4"
						>
							{loadError}
						</FeedbackNotice>
					)}
					<SettingsSection title={t("settings.integratedTerminal")}>
						<TerminalTypographySettings />
						<SettingsFieldRow
							label={t("settings.defaultTerminalProfile")}
							description={t("settings.defaultTerminalProfileDescription")}
						>
							{(ids) => (
								<PreferenceSelect
									{...ids}
									value={settings.integratedTerminalProfileId ?? AUTOMATIC_VALUE}
									options={integratedProfileOptions}
									disabled={disabled}
									onChange={updateProfile}
								/>
							)}
						</SettingsFieldRow>
					</SettingsSection>
					<SettingsSection title={t("settings.projectOpenActions")}>
						<SettingsFieldRow label={t("settings.defaultEditor")} description={t("settings.defaultEditorDescription")}>
							{(ids) => (
								<PreferenceSelect
									{...ids}
									value={settings.projectLaunchers.editor ?? AUTOMATIC_VALUE}
									options={editorOptions}
									disabled={disabled}
									onChange={(value) => updateLauncher("editor", value)}
								/>
							)}
						</SettingsFieldRow>
						<SettingsFieldRow
							label={t("settings.defaultExternalTerminal")}
							description={t("settings.defaultExternalTerminalDescription")}
						>
							{(ids) => (
								<PreferenceSelect
									{...ids}
									value={settings.projectLaunchers.terminal ?? AUTOMATIC_VALUE}
									options={terminalOptions}
									disabled={disabled}
									onChange={(value) => updateLauncher("terminal", value)}
								/>
							)}
						</SettingsFieldRow>
						<SettingsFieldRow
							label={t("settings.defaultFileManager")}
							description={t("settings.defaultFileManagerDescription")}
						>
							{(ids) => (
								<PreferenceSelect
									{...ids}
									value={settings.projectLaunchers["file-manager"] ?? AUTOMATIC_VALUE}
									options={fileManagerOptions}
									disabled={disabled}
									onChange={(value) => updateLauncher("file-manager", value)}
								/>
							)}
						</SettingsFieldRow>
					</SettingsSection>
				</>
			)}
		</SettingsPage>
	);
}
