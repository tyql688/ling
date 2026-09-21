import { z } from "zod";
import type { DatasetStoreStatus } from "./dataset-status";
import type { ProjectLaunchPreferences, ProjectLaunchTargetId, ProjectLaunchTargetKind } from "./project";

export type AppPlatform = "darwin" | "win32" | "linux" | "other";

/** Release identifiers are limited to 64 characters in runtime metadata and derived state headers. */
const APP_VERSION_MAX_CHARS = 64;
export const appVersionSchema = z.string().min(1).max(APP_VERSION_MAX_CHARS);

/** Closed set shared by renderer preferences and native-shell copy. */
export const UI_LANGUAGES = ["en", "zh-CN", "ja", "ko"] as const;
export type UiLanguage = (typeof UI_LANGUAGES)[number];

export const SYSTEM_PERMISSION_TARGETS = [
	"mac-accessibility",
	"mac-screen-recording",
	"mac-full-disk-access",
	"mac-automation",
	"mac-notifications",
	"windows-privacy",
	"windows-apps",
	"windows-notifications",
] as const;
export type SystemPermissionTarget = (typeof SYSTEM_PERMISSION_TARGETS)[number];

export type SystemPermissionStatus = "granted" | "denied" | "not-determined" | "restricted" | "unknown" | "unsupported";

export interface SystemPermissionState {
	target: SystemPermissionTarget;
	status: SystemPermissionStatus;
}

export interface AppSettingsSnapshot {
	keepRunningOnWindowClose: boolean;
	/** Applied at the next launch — Chromium only honors disableHardwareAcceleration() before app ready. */
	disableHardwareAcceleration: boolean;
	/** System notification when a background session's agent run finishes. */
	notifyBackgroundCompletion: boolean;
	/** System notification when a background session needs input (approval, dialog). */
	notifyAttentionNeeded: boolean;
	/** Whether delivered system notifications may play the operating system's alert sound. */
	playNotificationSounds: boolean;
	/** Independent defaults for project actions; null means the first available platform choice. */
	projectLaunchers: ProjectLaunchPreferences;
	/** null follows the detected login/default shell. */
	integratedTerminalProfileId: string | null;
	/** When on, @file completions exclude files listed in .gitignore (Git repos only; off keeps
	 * git-ignored but non-node_modules files reachable). Defaults to off. */
	fileMentionsRespectGitignore: boolean;
	/** Block display sleep while at least one agent run is in flight. Defaults to off. */
	keepAwakeWhileRunning: boolean;
}

export type AppSettingsReadResult =
	{ status: "ready"; settings: AppSettingsSnapshot } | Exclude<DatasetStoreStatus, { status: "ready" }>;

export type AppSettingsUpdate =
	| { type: "keepRunningOnWindowClose"; enabled: boolean }
	| { type: "disableHardwareAcceleration"; enabled: boolean }
	| { type: "notifyBackgroundCompletion"; enabled: boolean }
	| { type: "notifyAttentionNeeded"; enabled: boolean }
	| { type: "playNotificationSounds"; enabled: boolean }
	| { type: "projectLauncher"; kind: ProjectLaunchTargetKind; targetId: ProjectLaunchTargetId | null }
	| { type: "integratedTerminalProfile"; profileId: string | null }
	| { type: "fileMentionsRespectGitignore"; enabled: boolean }
	| { type: "keepAwakeWhileRunning"; enabled: boolean };

/** Closed set of settings-page zoom steps accepted by ShellApi.setZoomFactor, preventing arbitrary float zoom. */
export const INTERFACE_ZOOM_PERCENTS = [80, 90, 100, 110, 125, 150] as const;
/** Normalized native-shell theme source without exposing a runtime-specific type. */
export type ThemeSource = "system" | "light" | "dark";

/** Pi runtime metadata shown by package management and the application client. */
export interface AgentInfo {
	agentDir: string;
	piVersion: string;
}
