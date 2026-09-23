import { useDomainApi } from "@renderer/lib/host-api-context";
import type {
	AppPlatform,
	SystemPermissionState,
	SystemPermissionStatus,
	SystemPermissionTarget,
} from "@ling/contracts/application";
import type { UpdateEvent } from "@ling/contracts/update";
import { errorMessage } from "@ling/contracts/ling-error";
import { Button } from "@renderer/components/ui/button";
import { SettingsRow, SettingsSection } from "@renderer/components/ui/settings-list";
import { appPlatform } from "@renderer/lib/platform";
import { cn } from "@renderer/lib/utils";
import { ExternalLink, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

interface SystemPermissionRow {
	target: SystemPermissionTarget;
	labelKey: string;
	descriptionKey: string;
	requestable: boolean;
	/** False where the OS exposes no status to read, so the row shows an action but no badge. */
	readable: boolean;
}

/**
 * macOS system permission rows. Accessibility and Screen Recording can raise the system prompt
 * once; Full Disk Access has no request API at all, and Automation is granted per source/target
 * app pair rather than per app, so neither has anything to ask for beyond System Settings.
 */
const MAC_SYSTEM_PERMISSION_ROWS: readonly SystemPermissionRow[] = [
	{
		target: "mac-accessibility",
		labelKey: "settings.systemPermissionAccessibility",
		descriptionKey: "settings.systemPermissionAccessibilityDescription",
		requestable: true,
		readable: true,
	},
	{
		target: "mac-screen-recording",
		labelKey: "settings.systemPermissionScreenRecording",
		descriptionKey: "settings.systemPermissionScreenRecordingDescription",
		requestable: true,
		readable: true,
	},
	{
		target: "mac-full-disk-access",
		labelKey: "settings.systemPermissionFullDisk",
		descriptionKey: "settings.systemPermissionFullDiskDescription",
		requestable: false,
		readable: true,
	},
	{
		target: "mac-automation",
		labelKey: "settings.systemPermissionAutomation",
		descriptionKey: "settings.systemPermissionAutomationDescription",
		requestable: false,
		readable: false,
	},
];

/** Windows privacy/app permission guide rows (not requestable in-app, only jumps to the system page). */
const WINDOWS_SYSTEM_PERMISSION_ROWS: readonly SystemPermissionRow[] = [
	{
		target: "windows-privacy",
		labelKey: "settings.systemPermissionWindowsPrivacy",
		descriptionKey: "settings.systemPermissionWindowsPrivacyDescription",
		requestable: false,
		readable: false,
	},
	{
		target: "windows-apps",
		labelKey: "settings.systemPermissionWindowsApps",
		descriptionKey: "settings.systemPermissionWindowsAppsDescription",
		requestable: false,
		readable: false,
	},
];

function systemPermissionRows(platform: AppPlatform): readonly SystemPermissionRow[] {
	if (platform === "darwin") return MAC_SYSTEM_PERMISSION_ROWS;
	if (platform === "win32") return WINDOWS_SYSTEM_PERMISSION_ROWS;
	return [];
}

function statusToneClass(status: SystemPermissionStatus): string {
	if (status === "granted") return "border-transparent bg-success/10 text-success";
	if (status === "denied" || status === "restricted") return "border-transparent bg-danger/10 text-danger";
	return "border-border-subtle bg-surface-raised text-text-muted";
}

function SystemPermissionBadge({ status }: { status: SystemPermissionStatus }) {
	const { t } = useTranslation();
	return (
		<span
			className={cn(
				"inline-flex h-6 items-center rounded-full border px-2 text-xs font-medium",
				statusToneClass(status),
			)}
		>
			{t(`settings.systemPermissionStatus_${status}`)}
		</span>
	);
}

export function SystemPermissionsSection() {
	const hostUiApi = useDomainApi("ui");
	const hostAppApi = useDomainApi("app");

	const { t } = useTranslation();
	const rows = useMemo(
		() => (hostUiApi.capabilities.systemPermissions ? systemPermissionRows(appPlatform) : []),
		[hostUiApi],
	);
	const [states, setStates] = useState<Partial<Record<SystemPermissionTarget, SystemPermissionState>>>({});
	const [errors, setErrors] = useState<Partial<Record<SystemPermissionTarget, string>>>({});
	const lifecycleRevisionRef = useRef(0);
	const refreshInFlightRef = useRef(new Map<SystemPermissionTarget, Promise<void>>());
	const refreshQueuedRef = useRef(new Set<SystemPermissionTarget>());
	const actionInFlightRef = useRef(new Map<SystemPermissionTarget, Promise<void>>());
	const refreshRef = useRef<(target: SystemPermissionTarget) => void>(() => undefined);

	const clearError = useCallback((target: SystemPermissionTarget) => {
		setErrors((current) => {
			const next = { ...current };
			delete next[target];
			return next;
		});
	}, []);

	const refresh = useCallback(
		(target: SystemPermissionTarget) => {
			if (refreshInFlightRef.current.has(target)) {
				refreshQueuedRef.current.add(target);
				return;
			}
			const revision = lifecycleRevisionRef.current;
			const operation: Promise<void> = hostAppApi
				.getSystemPermission(target)
				.then((state) => {
					if (lifecycleRevisionRef.current !== revision) return;
					setStates((current) => ({ ...current, [target]: state }));
					clearError(target);
				})
				.catch((error: unknown) => {
					if (lifecycleRevisionRef.current !== revision) return;
					setErrors((current) => ({ ...current, [target]: errorMessage(error) }));
				})
				.finally(() => {
					if (refreshInFlightRef.current.get(target) !== operation) return;
					refreshInFlightRef.current.delete(target);
					if (lifecycleRevisionRef.current !== revision || !refreshQueuedRef.current.delete(target)) return;
					refreshRef.current(target);
				});
			refreshInFlightRef.current.set(target, operation);
		},
		[hostAppApi, clearError],
	);
	refreshRef.current = refresh;

	useEffect(() => {
		lifecycleRevisionRef.current += 1;
		for (const row of rows) if (row.readable) refresh(row.target);
		const refreshOnFocus = () => {
			for (const row of rows) if (row.readable) refresh(row.target);
		};
		window.addEventListener("focus", refreshOnFocus);
		return () => {
			lifecycleRevisionRef.current += 1;
			// eslint-disable-next-line react-hooks/exhaustive-deps -- the cleanup deliberately reads the ref as it stands at teardown, not the value captured at setup
			refreshQueuedRef.current.clear();
			// eslint-disable-next-line react-hooks/exhaustive-deps -- the cleanup deliberately reads the ref as it stands at teardown, not the value captured at setup
			refreshInFlightRef.current.clear();
			// eslint-disable-next-line react-hooks/exhaustive-deps -- the cleanup deliberately reads the ref as it stands at teardown, not the value captured at setup
			actionInFlightRef.current.clear();
			window.removeEventListener("focus", refreshOnFocus);
		};
	}, [rows, refresh]);

	/** One action per target at a time; results from before a remount are dropped. */
	const run = (target: SystemPermissionTarget, action: (current: () => boolean) => Promise<void>) => {
		if (actionInFlightRef.current.has(target)) return;
		const revision = lifecycleRevisionRef.current;
		const current = () => lifecycleRevisionRef.current === revision;
		clearError(target);
		const operation: Promise<void> = action(current)
			.catch((error: unknown) => {
				if (current()) setErrors((errors) => ({ ...errors, [target]: errorMessage(error) }));
			})
			.finally(() => {
				if (actionInFlightRef.current.get(target) === operation) actionInFlightRef.current.delete(target);
			});
		actionInFlightRef.current.set(target, operation);
	};
	const request = (target: SystemPermissionTarget) =>
		run(target, async (current) => {
			const state = await hostAppApi.requestSystemPermission(target);
			if (current()) setStates((states) => ({ ...states, [target]: state }));
		});
	const open = (target: SystemPermissionTarget) => run(target, () => hostAppApi.openSystemPermission(target));

	if (rows.length === 0) return null;

	return (
		<SettingsSection title={t("settings.systemPermissions")}>
			{rows.map((row) => {
				const state = states[row.target];
				return (
					<SettingsRow
						key={row.target}
						label={t(row.labelKey)}
						description={errors[row.target] ?? t(row.descriptionKey)}
					>
						{row.readable && state && <SystemPermissionBadge status={state.status} />}
						{/* Asking again once the grant exists is a no-op; the row keeps "open" so the user
						    can still revoke it in System Settings. */}
						{row.requestable && state?.status !== "granted" && (
							<Button variant="outline" size="sm" onClick={() => request(row.target)}>
								<ShieldCheck className="size-3.5" aria-hidden="true" />
								{t("settings.systemPermissionRequest")}
							</Button>
						)}
						<Button variant="outline" size="sm" onClick={() => open(row.target)}>
							<ExternalLink className="size-3.5" aria-hidden="true" />
							{t("settings.systemPermissionOpen")}
						</Button>
					</SettingsRow>
				);
			})}
		</SettingsSection>
	);
}

/** Version row plus the native updater state machine (check → download → restart-install). */
export function UpdateRow() {
	const hostUpdatesApi = useDomainApi("updates");
	const appApi = useDomainApi("app");

	const { t } = useTranslation();
	const [appVersion, setAppVersion] = useState("");
	const [supported, setSupported] = useState(false);
	const [manualDownloadUrl, setManualDownloadUrl] = useState<string>();
	const [phase, setPhase] = useState<UpdateEvent | null>(null);

	useEffect(() => {
		let cancelled = false;
		let eventReceived = false;
		void hostUpdatesApi
			.getState()
			.then((state) => {
				if (cancelled) return;
				setAppVersion(state.appVersion);
				setSupported(state.supported);
				setManualDownloadUrl(state.manualDownloadUrl);
				if (!eventReceived) setPhase(state.event);
			})
			.catch((error: unknown) => {
				if (!cancelled && !eventReceived) setPhase({ type: "error", message: errorMessage(error) });
			});
		const unsubscribe = hostUpdatesApi.onEvent((event: UpdateEvent) => {
			eventReceived = true;
			setPhase(event);
		});
		return () => {
			cancelled = true;
			unsubscribe();
		};
	}, [hostUpdatesApi]);

	const invoke = (action: () => Promise<void>) => {
		action().catch((error: unknown) => {
			setPhase((current) =>
				current?.type === "error" && current.restartRequired
					? current
					: { type: "error", message: errorMessage(error) },
			);
		});
	};

	const status = (() => {
		switch (phase?.type) {
			case undefined:
				return manualDownloadUrl ? t("settings.updateManualDescription") : null;
			case "checking":
				return t("settings.updateChecking");
			case "not-available":
				return t("settings.updateNone");
			case "available":
				return t("settings.updateAvailable", { version: phase.version });
			case "download-progress":
				return t("settings.updateDownloading", { percent: phase.percent });
			case "downloaded":
				return t("settings.updateDownloaded", { version: phase.version });
			case "installing":
				return t("settings.updateInstalling");
			case "error":
				return phase.restartRequired
					? t("settings.updateRestartRequired", { message: phase.message })
					: t("settings.updateFailed", { message: phase.message });
		}
	})();

	return (
		<SettingsRow label={t("settings.version")} description={appVersion}>
			{status && (
				<span className="max-w-64 truncate text-xs text-text-muted" title={status}>
					{status}
				</span>
			)}
			{manualDownloadUrl && (
				<Button variant="outline" size="sm" onClick={() => invoke(() => appApi.openExternal(manualDownloadUrl))}>
					<ExternalLink className="size-3.5" aria-hidden="true" />
					{t("settings.updateOpenDownloads")}
				</Button>
			)}
			{supported &&
				(phase === null || phase.type === "not-available" || (phase.type === "error" && !phase.restartRequired)) && (
					<Button variant="outline" size="sm" onClick={() => invoke(() => hostUpdatesApi.check())}>
						{t("settings.updateCheck")}
					</Button>
				)}
			{supported && phase?.type === "available" && (
				<Button variant="outline" size="sm" onClick={() => invoke(() => hostUpdatesApi.download())}>
					{t("settings.updateDownload")}
				</Button>
			)}
			{supported && phase?.type === "downloaded" && (
				<Button variant="outline" size="sm" onClick={() => invoke(() => hostUpdatesApi.install())}>
					{t("settings.updateInstall")}
				</Button>
			)}
		</SettingsRow>
	);
}
