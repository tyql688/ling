import type { ShellProcedureClient } from "./shell-procedures";
import type { AppPlatform, SystemPermissionStatus, ThemeSource } from "../application";
import type { HostShellEvent } from "../host-shell";
import type { ExtensionTerminalInputReplayRequest } from "../session";

export interface ShellCapabilities {
	directoryPicker: boolean;
	droppedFilePaths: boolean;
	nativePathOpen: boolean;
	nativePathReveal: boolean;
	systemPermissions: boolean;
	updates: boolean;
	nativeNotifications: boolean;
	notificationPermissionRequest: boolean;
	windowClosePersistence: boolean;
	hardwareAccelerationControl: boolean;
	screenWakeLock: boolean;
	windowTranslucency: boolean;
	nativeLanguageSync: boolean;
	extensionInputReplay: boolean;
}

export type ShellNotificationPermission = Extract<
	SystemPermissionStatus,
	"granted" | "denied" | "not-determined" | "unsupported"
>;

export interface ShellEnvironment {
	home: string | null;
	platform: AppPlatform;
}

export interface ShellApi {
	capabilities: ShellCapabilities;
	environment: ShellEnvironment;
	host: ShellProcedureClient["host"];
	lifecycle: ShellProcedureClient["lifecycle"] & {
		handleHostEvent(event: HostShellEvent): void;
	};
	app: ShellProcedureClient["app"] & {
		getNotificationPermission(): Promise<ShellNotificationPermission>;
		requestNotificationPermission(): Promise<ShellNotificationPermission>;
	};
	window: Omit<ShellProcedureClient["window"], "setTheme"> & {
		setTheme(source: ThemeSource, foreground: string | null): Promise<void>;
	};
	filesystem: ShellProcedureClient["filesystem"] & {
		getDroppedFilePaths(files: File[]): Promise<Array<string | null>>;
	};
	input: {
		replayExtensionTerminalInput(request: ExtensionTerminalInputReplayRequest): Promise<void>;
	};
	updates: ShellProcedureClient["updates"];
}

/**
 * Windows 11 22H2 introduced the background material Ling requests for translucent windows.
 * Main gates the window itself; preload reports the same answer to the renderer so its chrome
 * matches. Both must decide from one build number — they read the version through different
 * APIs (`os.release()` in main, `process.getSystemVersion()` in the sandboxed preload).
 */
const WINDOWS_ACRYLIC_MIN_BUILD = 22621;

/** `version` is a Windows version string such as `10.0.22621`; non-Windows callers must not call this. */
export function supportsWindowsAcrylicBuild(version: string): boolean {
	return Number.parseInt(version.split(".")[2] ?? "0", 10) >= WINDOWS_ACRYLIC_MIN_BUILD;
}
