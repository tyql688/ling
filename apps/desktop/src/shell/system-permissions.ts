import type {
	AppPlatform,
	SystemPermissionState,
	SystemPermissionStatus,
	SystemPermissionTarget,
} from "@ling/contracts/application";
import { shell, systemPreferences } from "electron";
import { createRequire } from "node:module";

type PermissionPlatform = "darwin" | "win32";

interface SystemPermissionConfig {
	platform: PermissionPlatform;
	settingsUrl: string;
}

const SYSTEM_PERMISSION_CONFIGS = {
	"mac-accessibility": {
		platform: "darwin",
		settingsUrl: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
	},
	"mac-screen-recording": {
		platform: "darwin",
		settingsUrl: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
	},
	"mac-full-disk-access": {
		platform: "darwin",
		settingsUrl: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
	},
	"mac-automation": {
		platform: "darwin",
		settingsUrl: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation",
	},
	"mac-notifications": {
		platform: "darwin",
		settingsUrl: "x-apple.systempreferences:com.apple.preference.notifications",
	},
	"windows-privacy": { platform: "win32", settingsUrl: "ms-settings:privacy" },
	"windows-apps": { platform: "win32", settingsUrl: "ms-settings:appsfeatures" },
	"windows-notifications": { platform: "win32", settingsUrl: "ms-settings:notifications" },
} satisfies Record<SystemPermissionTarget, SystemPermissionConfig>;

type MacAuthStatus = "authorized" | "denied" | "not determined" | "restricted" | "limited" | "provisional";

interface MacPermissionsModule {
	getAuthStatus(type: "accessibility" | "screen" | "full-disk-access"): MacAuthStatus;
	askForScreenCaptureAccess(openPreferences?: boolean): void;
}

function appPlatform(): AppPlatform {
	if (process.platform === "darwin" || process.platform === "win32" || process.platform === "linux") {
		return process.platform;
	}
	return "other";
}

let macPermissionsModule: MacPermissionsModule | null = null;

function macPermissions(): MacPermissionsModule {
	if (macPermissionsModule) return macPermissionsModule;
	macPermissionsModule = createRequire(import.meta.url)("node-mac-permissions") as MacPermissionsModule;
	return macPermissionsModule;
}

function normalizeMacStatus(status: MacAuthStatus): SystemPermissionStatus {
	if (status === "authorized") return "granted";
	if (status === "denied") return "denied";
	if (status === "not determined") return "not-determined";
	if (status === "restricted") return "restricted";
	return "unknown";
}

function ensureSupported(target: SystemPermissionTarget): void {
	const platform = appPlatform();
	if (platform !== SYSTEM_PERMISSION_CONFIGS[target].platform) {
		throw new Error(`System permission ${target} is not supported on ${platform}`);
	}
}

export function getSystemPermissionState(value: SystemPermissionTarget): SystemPermissionState {
	const platform = appPlatform();
	if (platform !== SYSTEM_PERMISSION_CONFIGS[value].platform) return { target: value, status: "unsupported" };
	if (value === "mac-accessibility") {
		return {
			target: value,
			status: normalizeMacStatus(macPermissions().getAuthStatus("accessibility")),
		};
	}
	if (value === "mac-screen-recording") {
		return { target: value, status: normalizeMacStatus(macPermissions().getAuthStatus("screen")) };
	}
	if (value === "mac-full-disk-access") {
		return {
			target: value,
			status: normalizeMacStatus(macPermissions().getAuthStatus("full-disk-access")),
		};
	}
	return { target: value, status: "unknown" };
}

export async function requestSystemPermission(value: SystemPermissionTarget): Promise<SystemPermissionState> {
	ensureSupported(value);
	if (value === "mac-accessibility") systemPreferences.isTrustedAccessibilityClient(true);
	else if (value === "mac-screen-recording") macPermissions().askForScreenCaptureAccess(false);
	else await openSystemPermissionSettings(value);
	return getSystemPermissionState(value);
}

export async function openSystemPermissionSettings(value: SystemPermissionTarget): Promise<void> {
	ensureSupported(value);
	await shell.openExternal(SYSTEM_PERMISSION_CONFIGS[value].settingsUrl);
}
