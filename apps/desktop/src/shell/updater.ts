import type { UpdateEvent, UpdateState } from "@ling/contracts/update";
import { toError } from "@ling/contracts/ling-error";
import type { AppUpdater } from "electron-updater";
interface DesktopUpdaterOptions {
	updater: Pick<
		AppUpdater,
		| "on"
		| "off"
		| "autoDownload"
		| "autoInstallOnAppQuit"
		| "autoRunAppAfterInstall"
		| "checkForUpdates"
		| "downloadUpdate"
		| "quitAndInstall"
	>;
	appVersion: string;
	supported: boolean;
	prepareInstall(): Promise<void>;
	onPrepared(): void;
	onInstallFailed(error: Error): void;
	onEvent(event: UpdateEvent): void;
}

export function createDesktopUpdater(options: DesktopUpdaterOptions) {
	const autoUpdater = options.updater;
	let stopped = false;
	let disposed = false;
	let latestEvent: UpdateEvent | null = null;
	let downloadedVersion: string | null = null;
	let activeRequest = false;
	let activeTask: Promise<unknown> | null = null;
	let cancellationToken: NonNullable<Parameters<typeof autoUpdater.downloadUpdate>[0]> | null = null;
	let stopPromise: Promise<void> | null = null;
	let installation: "idle" | "preparing" | "handed-off" | "failed" = "idle";
	let installationFailure: Error | null = null;
	let installPromise: Promise<void> | null = null;
	const publish = (event: UpdateEvent): void => {
		if (disposed) return;
		if (stopped && installation === "idle") return;
		if (installation !== "idle" && event.type !== "installing" && event.type !== "error") return;
		latestEvent = event;
		options.onEvent(event);
	};
	const assertAvailable = (): void => {
		if (stopped || disposed) throw new Error("The updater is shutting down");
		if (!options.supported) throw new Error("Updates are only available in packaged builds");
		if (installation !== "idle") throw new Error("Update installation has started. Restart Ling before retrying.");
	};
	const installFailed = (error: unknown): Error => {
		if (installationFailure) return installationFailure;
		installation = "failed";
		const failure = (installationFailure = toError(error));
		publish({ type: "error", message: failure.message, restartRequired: true });
		// Installation can outlive Host and shell IPC, so failures need a native notice.
		options.onInstallFailed(failure);
		return failure;
	};
	const handoff = (relaunch: boolean): void => {
		options.onPrepared();
		installation = "handed-off";
		// macOS reads this property; NSIS/Linux also receive the explicit silent/relaunch flags.
		autoUpdater.autoRunAppAfterInstall = relaunch;
		autoUpdater.quitAndInstall(!relaunch, relaunch);
		// Some installers emit an error synchronously instead of throwing from quitAndInstall.
		if (installationFailure) throw installationFailure;
	};

	autoUpdater.autoDownload = false;
	// Both explicit installation and quit-time installation must pass Ling's drain barrier.
	autoUpdater.autoInstallOnAppQuit = false;
	const cleanups: Array<() => void> = [];
	function listen<Event extends Parameters<typeof autoUpdater.on>[0]>(
		event: Event,
		listener: Parameters<typeof autoUpdater.on<Event>>[1],
	): void {
		autoUpdater.on(event, listener);
		cleanups.push(() => autoUpdater.off(event, listener));
	}

	listen("checking-for-update", () => publish({ type: "checking" }));
	listen("update-not-available", () => publish({ type: "not-available" }));
	listen("update-available", ({ version }) => publish({ type: "available", version }));
	listen("download-progress", ({ percent }) => publish({ type: "download-progress", percent: Math.round(percent) }));
	listen("update-downloaded", ({ version }) => {
		downloadedVersion = version;
		publish({ type: "downloaded", version });
	});
	listen("error", (error) => {
		if (installation !== "idle") installFailed(error);
		else if (stopped) {
			console.error("Updater request failed during shutdown", error);
		} else publish({ type: "error", message: error.message });
	});

	return {
		/** Stop requests before draining Host, but retain installation events until Electron exits. */
		stop() {
			if (stopPromise) return stopPromise;
			stopped = true;
			cancellationToken?.cancel();
			if (!activeTask) {
				stopPromise = Promise.resolve();
				return stopPromise;
			}
			// The caller owns request failures; shutdown still waits for the request to settle before draining Host.
			const settled = Promise.allSettled([activeTask]).then(() => undefined);
			let deadline: ReturnType<typeof setTimeout>;
			// The SDK cannot cancel an update check; five seconds bounds native cleanup before Host's own drain.
			const timeout = new Promise<never>((_resolve, reject) => {
				deadline = setTimeout(() => reject(new Error("Updater request did not settle during shutdown")), 5000);
			});
			stopPromise = Promise.race([settled, timeout]).finally(() => clearTimeout(deadline));
			return stopPromise;
		},
		/** Final listener cleanup belongs to Electron's quit event, after the installer handoff. */
		dispose(): void {
			disposed = true;
			cancellationToken?.cancel();
			for (const cleanup of cleanups) cleanup();
			cleanups.length = 0;
		},
		getState: (): UpdateState => ({
			appVersion: options.appVersion,
			supported: options.supported,
			event: latestEvent,
		}),
		check: async (): Promise<void> => {
			assertAvailable();
			if (activeRequest) throw new Error("An update request is already running");
			if (downloadedVersion !== null) {
				publish({ type: "downloaded", version: downloadedVersion });
				return;
			}
			activeRequest = true;
			try {
				const checking = autoUpdater.checkForUpdates();
				activeTask = checking;
				const result = await checking;
				if (result === null) throw new Error("The update check did not return a result");
				cancellationToken = result.cancellationToken ?? null;
				if (stopped || disposed) cancellationToken?.cancel();
			} catch (error) {
				publish({ type: "error", message: toError(error).message });
				throw error;
			} finally {
				activeRequest = false;
				activeTask = null;
			}
		},
		download: async (): Promise<void> => {
			assertAvailable();
			if (activeRequest) throw new Error("An update request is already running");
			if (latestEvent?.type !== "available") throw new Error("Check for an available update before downloading");
			activeRequest = true;
			publish({ type: "download-progress", percent: 0 });
			try {
				const downloading = autoUpdater.downloadUpdate(cancellationToken ?? undefined);
				activeTask = downloading;
				await downloading;
			} catch (error) {
				publish({ type: "error", message: toError(error).message });
				throw error;
			} finally {
				activeRequest = false;
				activeTask = null;
			}
		},
		install: (): Promise<void> => {
			if (installPromise) return installPromise;
			assertAvailable();
			if (activeRequest || downloadedVersion === null)
				throw new Error("An update must finish downloading before installation");
			installation = "preparing";
			publish({ type: "installing" });
			installPromise = Promise.resolve().then(async () => {
				try {
					await options.prepareInstall();
					if (installation === "failed") throw new Error("Update preparation failed. Restart Ling before retrying.");
					handoff(true);
				} catch (error) {
					throw installFailed(error);
				}
			});
			return installPromise;
		},
		/** Called only after ordinary shutdown has drained every owner successfully. */
		installOnQuit: (): boolean => {
			if (downloadedVersion === null || installation !== "idle") return false;
			installation = "preparing";
			publish({ type: "installing" });
			try {
				handoff(false);
				return true;
			} catch (error) {
				throw installFailed(error);
			}
		},
	};
}
