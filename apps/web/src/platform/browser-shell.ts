import type { HostConnectionInfo, HostShellEvent } from "@ling/contracts/host-shell";
import type { SessionRef } from "@ling/contracts/session";
import { toError } from "@ling/contracts/ling-error";
import { sameSessionRef, sessionKey } from "@ling/contracts/session-ref";
import type { ShellApi, ShellEnvironment } from "@ling/contracts/api/shell-api";
import type { HostApi } from "@ling/contracts/api/host-procedures";

function unsupported(capability: string): Error {
	return Object.assign(new Error(`${capability} is not available in the Web product`), { code: "UNSUPPORTED" });
}

function openExternal(url: string): Promise<void> {
	const parsed = new URL(url);
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		return Promise.reject(new Error("Only HTTP and HTTPS links may be opened externally"));
	}
	const anchor = document.createElement("a");
	anchor.href = parsed.href;
	anchor.target = "_blank";
	anchor.rel = "noopener noreferrer";
	anchor.hidden = true;
	document.body.append(anchor);
	anchor.click();
	anchor.remove();
	return Promise.resolve();
}

function browserNotificationPermission(): "granted" | "denied" | "not-determined" | "unsupported" {
	if (!("Notification" in window)) return "unsupported";
	return Notification.permission === "default" ? "not-determined" : Notification.permission;
}

export function createBrowserShell(
	connection: HostConnectionInfo,
	environment: ShellEnvironment,
	appVersion: string,
	signal: AbortSignal,
	browseDirectory: HostApi["project"]["browseDirectories"],
): ShellApi {
	signal.throwIfAborted();
	const activationListeners = new Set<(ref: SessionRef) => void>();
	const notifications = new Map<string, Notification>();
	const runningSessions = new Set<string>();
	let viewedSession: SessionRef | null = null;
	let keepAwakeEnabled = false;
	let wakeLock: WakeLockSentinel | null = null;
	let wakeLockUpdate: Promise<void> | null = null;
	let wakeLockDirty = false;
	const closeNotification = (ref: SessionRef): void => {
		const key = sessionKey(ref);
		notifications.get(key)?.close();
		notifications.delete(key);
	};
	const syncWakeLock = (): Promise<void> => {
		wakeLockDirty = true;
		if (wakeLockUpdate) return wakeLockUpdate;
		const shouldHold = (): boolean =>
			!signal.aborted && keepAwakeEnabled && runningSessions.size > 0 && document.visibilityState === "visible";
		const reconcile = async (): Promise<void> => {
			for (;;) {
				if (!shouldHold()) {
					if (wakeLock === null) return;
					const previous = wakeLock;
					wakeLock = null;
					await previous.release();
					continue;
				}
				if (wakeLock !== null || !("wakeLock" in navigator)) return;
				const acquired = await navigator.wakeLock.request("screen");
				wakeLock = acquired;
				acquired.addEventListener(
					"release",
					() => {
						if (wakeLock === acquired) wakeLock = null;
					},
					{ once: true },
				);
			}
		};
		const update = async (): Promise<void> => {
			while (wakeLockDirty) {
				wakeLockDirty = false;
				await reconcile();
			}
		};
		wakeLockUpdate = update().finally(() => {
			wakeLockUpdate = null;
			if (wakeLockDirty) requestWakeLockSync();
		});
		return wakeLockUpdate;
	};
	const requestWakeLockSync = (): void => {
		void syncWakeLock().catch((error: unknown) => window.reportError(toError(error)));
	};
	document.addEventListener("visibilitychange", requestWakeLockSync, { signal });
	signal.addEventListener(
		"abort",
		() => {
			activationListeners.clear();
			runningSessions.clear();
			for (const notification of notifications.values()) notification.close();
			notifications.clear();
			requestWakeLockSync();
		},
		{ once: true },
	);
	const handleHostEvent = (event: HostShellEvent): void => {
		if (signal.aborted) return;
		if (event.type === "keepAwakePreference") {
			keepAwakeEnabled = event.enabled;
			requestWakeLockSync();
			return;
		}
		if (event.type === "keepRunningPreference") return;
		if (event.type === "graphicsPreference") return;
		if (event.type === "agentRunState") {
			const key = sessionKey(event.ref);
			if (event.running) runningSessions.add(key);
			else runningSessions.delete(key);
			requestWakeLockSync();
			return;
		}
		if (
			document.visibilityState === "visible" &&
			document.hasFocus() &&
			viewedSession !== null &&
			sameSessionRef(viewedSession, event.ref)
		) {
			return;
		}
		if (!("Notification" in window) || Notification.permission !== "granted") return;
		closeNotification(event.ref);
		const notification = new Notification(event.title, { body: event.body, silent: event.silent });
		const key = sessionKey(event.ref);
		notifications.set(key, notification);
		notification.addEventListener("close", () => {
			if (notifications.get(key) === notification) notifications.delete(key);
		});
		notification.addEventListener("click", () => {
			if (signal.aborted || notifications.get(key) !== notification) return;
			window.focus();
			for (const callback of activationListeners) callback(event.ref);
			closeNotification(event.ref);
		});
	};
	return {
		capabilities: {
			directoryPicker: true,
			droppedFilePaths: false,
			nativePathOpen: false,
			nativePathReveal: false,
			systemPermissions: false,
			updates: false,
			nativeNotifications: "Notification" in window,
			notificationPermissionRequest: "Notification" in window,
			windowClosePersistence: false,
			hardwareAccelerationControl: false,
			screenWakeLock: "wakeLock" in navigator,
			windowTranslucency: false,
			nativeLanguageSync: false,
			extensionInputReplay: false,
		},
		environment,
		host: { connection: () => Promise.resolve(connection) },
		lifecycle: {
			handleHostEvent,
			setViewedSession: (ref) => {
				viewedSession = ref === null ? null : { ...ref };
				if (viewedSession !== null && document.visibilityState === "visible" && document.hasFocus()) {
					closeNotification(viewedSession);
				}
				return Promise.resolve();
			},
			onActivateSession: (callback) => {
				signal.throwIfAborted();
				activationListeners.add(callback);
				return () => activationListeners.delete(callback);
			},
		},
		app: {
			openExternal,
			getNotificationPermission: () => Promise.resolve(browserNotificationPermission()),
			requestNotificationPermission: async () => {
				if (!("Notification" in window)) return "unsupported";
				await Notification.requestPermission();
				return browserNotificationPermission();
			},
			getSystemPermission: (target) => Promise.resolve({ target, status: "unsupported" }),
			requestSystemPermission: (target) => Promise.reject(unsupported(`System permission ${target}`)),
			openSystemPermission: (target) => Promise.reject(unsupported(`System permission settings ${target}`)),
		},
		window: {
			setZoomFactor: (factor) => {
				document.documentElement.style.zoom = String(factor);
				return Promise.resolve();
			},
			setTheme: () => Promise.resolve(),
			setLanguage: () => Promise.reject(unsupported("Native UI language synchronization")),
		},
		filesystem: {
			chooseDirectory: async () => {
				const { chooseBrowserHostDirectory } = await import("./browser-directory-picker");
				return chooseBrowserHostDirectory(environment.home, browseDirectory, signal);
			},
			openPath: () => Promise.reject(unsupported("Opening a host path")),
			revealPath: () => Promise.reject(unsupported("Revealing a host path")),
			getDroppedFilePaths: (files) => Promise.resolve(files.map(() => null)),
		},
		input: {
			replayExtensionTerminalInput: () => Promise.reject(unsupported("Native extension input replay")),
		},
		updates: {
			getState: () => Promise.resolve({ appVersion, supported: false, event: null }),
			check: () => Promise.reject(unsupported("Application updates")),
			download: () => Promise.reject(unsupported("Application updates")),
			install: () => Promise.reject(unsupported("Application updates")),
			onEvent: () => () => undefined,
		},
	};
}
