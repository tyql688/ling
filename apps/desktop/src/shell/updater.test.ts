import type { UpdateEvent } from "@ling/contracts/update";
import type { AppUpdater, UpdateCheckResult } from "electron-updater";
import { EventEmitter } from "node:events";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createDesktopUpdater } from "./updater";

const info = { version: "0.2.0", files: [], path: "update.zip", sha512: "fixture", releaseDate: "2026-09-22" };
const available: UpdateCheckResult = { isUpdateAvailable: true, updateInfo: info, versionInfo: info };

function createFixture(prepareInstall?: () => Promise<void>, supported = true) {
	const events = new EventEmitter();
	const received: UpdateEvent[] = [];
	const backend = {
		// The real updater's typed emitter returns its full instance; only its event port is needed here.
		on: events.on.bind(events) as AppUpdater["on"],
		off: events.off.bind(events) as AppUpdater["off"],
		autoDownload: true,
		autoInstallOnAppQuit: true,
		autoRunAppAfterInstall: true,
		checkForUpdates: vi.fn(async (): Promise<UpdateCheckResult | null> => {
			events.emit("checking-for-update");
			events.emit("update-available", info);
			return available;
		}),
		downloadUpdate: vi.fn<AppUpdater["downloadUpdate"]>(async () => {
			events.emit("update-downloaded", { ...info, downloadedFile: "/fixture/update.zip" });
			return ["/fixture/update.zip"];
		}),
		quitAndInstall: vi.fn<AppUpdater["quitAndInstall"]>(),
	};
	const onInstallFailed = vi.fn();
	const onPrepared = vi.fn();
	const updater = createDesktopUpdater({
		updater: backend,
		appVersion: "0.1.0",
		supported,
		prepareInstall: prepareInstall ?? (() => updater.stop()),
		onPrepared,
		onInstallFailed,
		onEvent: (event) => received.push(event),
	});
	void updater.setAutoDownload(false);
	onTestFinished(() => updater.dispose());
	return { updater, backend, events, received, onInstallFailed, onPrepared };
}

describe("desktop update lifecycle", () => {
	it("checks after startup and periodically, then releases the schedule on shutdown", async () => {
		vi.useFakeTimers();
		onTestFinished(() => {
			vi.useRealTimers();
		});
		const { updater, backend } = createFixture();
		updater.start();
		updater.start();
		await vi.advanceTimersByTimeAsync(9_999);
		expect(backend.checkForUpdates).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(backend.checkForUpdates).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000);
		expect(backend.checkForUpdates).toHaveBeenCalledTimes(2);
		await updater.stop();
		await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000);
		expect(backend.checkForUpdates).toHaveBeenCalledTimes(2);
	});

	it("does not race scheduled checks with a download and stops scheduling when it is ready", async () => {
		vi.useFakeTimers();
		onTestFinished(() => {
			vi.useRealTimers();
		});
		const { updater, backend, events } = createFixture();
		const downloading = Promise.withResolvers<string[]>();
		backend.downloadUpdate.mockReturnValueOnce(downloading.promise);
		await updater.check();
		updater.start();
		const request = updater.download();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(backend.checkForUpdates).toHaveBeenCalledOnce();
		events.emit("update-downloaded", info);
		downloading.resolve([]);
		await request;
		await vi.advanceTimersByTimeAsync(8 * 60 * 60 * 1000);
		expect(backend.checkForUpdates).toHaveBeenCalledOnce();
	});
	it("downloads only with consent, including enabling after an available check", async () => {
		const { updater, backend } = createFixture();
		await updater.check();
		expect(backend.downloadUpdate).not.toHaveBeenCalled();
		await updater.setAutoDownload(true);
		expect(backend.downloadUpdate).toHaveBeenCalledOnce();
		expect(updater.getState().event).toEqual({ type: "downloaded", version: info.version });
		await updater.setAutoDownload(true);
		await updater.check();
		expect(backend.downloadUpdate).toHaveBeenCalledOnce();
		expect(backend.quitAndInstall).not.toHaveBeenCalled();
	});

	it("applies the latest preference when a pending check finds an update", async () => {
		const { updater, backend, events } = createFixture();
		const checking = Promise.withResolvers<UpdateCheckResult>();
		backend.checkForUpdates.mockImplementationOnce(() => checking.promise);
		await updater.setAutoDownload(true);
		const request = updater.check();
		await updater.setAutoDownload(false);
		events.emit("update-available", info);
		checking.resolve(available);
		await request;
		expect(backend.downloadUpdate).not.toHaveBeenCalled();
		await updater.setAutoDownload(true);
		expect(backend.downloadUpdate).toHaveBeenCalledOnce();
	});

	it("owns automatic downloads through shutdown cancellation", async () => {
		const { updater, backend } = createFixture();
		const downloading = Promise.withResolvers<string[]>();
		const started = Promise.withResolvers<void>();
		const cancel = vi.fn(() => downloading.reject(new Error("Download cancelled")));
		const token = { cancel } as unknown as NonNullable<UpdateCheckResult["cancellationToken"]>;
		backend.checkForUpdates.mockResolvedValueOnce({ ...available, cancellationToken: token });
		backend.downloadUpdate.mockImplementationOnce(() => {
			started.resolve();
			return downloading.promise;
		});
		await updater.setAutoDownload(true);
		const request = updater.check();
		const failed = expect(request).rejects.toThrow("Download cancelled");
		await started.promise;
		expect(updater.getState().event).toEqual({ type: "download-progress", percent: 0 });
		await expect(updater.check()).rejects.toThrow("already running");
		const stopped = updater.stop();
		await Promise.all([failed, stopped]);
		expect(cancel).toHaveBeenCalledOnce();
		expect(backend.downloadUpdate).toHaveBeenCalledExactlyOnceWith(token);
		expect(backend.quitAndInstall).not.toHaveBeenCalled();
	});

	it("allows another check after an automatic download fails", async () => {
		const { updater, backend } = createFixture();
		backend.downloadUpdate.mockRejectedValueOnce(new Error("Download interrupted"));
		await updater.setAutoDownload(true);
		await expect(updater.check()).rejects.toThrow("Download interrupted");
		expect(updater.getState().event).toEqual({ type: "error", message: "Download interrupted" });
		await updater.check();
		expect(updater.getState().event).toEqual({ type: "downloaded", version: info.version });
	});
	it("rejects native updates in development builds", async () => {
		const { updater, backend } = createFixture(undefined, false);
		await updater.setAutoDownload(true);
		expect(updater.getState()).toMatchObject({ supported: false });
		await expect(updater.check()).rejects.toThrow("packaged builds");
		await expect(updater.download()).rejects.toThrow("packaged builds");
		expect(() => updater.install()).toThrow("packaged builds");
		expect(backend.downloadUpdate).not.toHaveBeenCalled();
	});

	it("reports a native installation error after request shutdown and releases listeners only at final quit", async () => {
		const { updater, events, onInstallFailed } = createFixture();
		await updater.check();
		await updater.download();
		await updater.install();
		const failure = new Error("The downloaded app has an invalid signature");
		events.emit("error", failure);
		events.emit("error", failure);
		expect(onInstallFailed).toHaveBeenCalledExactlyOnceWith(failure);
		expect(updater.getState().event).toEqual({ type: "error", message: failure.message, restartRequired: true });
		expect(updater.installOnQuit()).toBe(false);
		updater.dispose();
		expect(events.eventNames()).toEqual([]);
	});

	it("installs silently without reopening after ordinary quit", async () => {
		const { updater, backend } = createFixture();
		await updater.check();
		await updater.download();
		await updater.stop();
		expect(updater.installOnQuit()).toBe(true);
		expect(backend.autoRunAppAfterInstall).toBe(false);
		expect(backend.quitAndInstall).toHaveBeenCalledExactlyOnceWith(true, false);
		expect(updater.installOnQuit()).toBe(false);
	});

	it("waits for preparation once and relaunches only for explicit restart-and-install", async () => {
		const preparation = Promise.withResolvers<void>();
		const { updater, backend } = createFixture(() => preparation.promise);
		await updater.check();
		await updater.download();
		const installing = updater.install();
		expect(updater.install()).toBe(installing);
		expect(backend.quitAndInstall).not.toHaveBeenCalled();
		await expect(updater.check()).rejects.toThrow("installation has started");
		preparation.resolve();
		await installing;
		expect(backend.autoRunAppAfterInstall).toBe(true);
		expect(backend.quitAndInstall).toHaveBeenCalledExactlyOnceWith(false, true);
	});

	it("does not hand off an update after preparation fails", async () => {
		const failure = new Error("Host could not drain");
		const { updater, backend, onInstallFailed, onPrepared } = createFixture(async () => {
			throw failure;
		});
		await updater.check();
		await updater.download();
		await expect(updater.install()).rejects.toBe(failure);
		expect(onPrepared).not.toHaveBeenCalled();
		expect(backend.quitAndInstall).not.toHaveBeenCalled();
		expect(onInstallFailed).toHaveBeenCalledExactlyOnceWith(failure);
		expect(updater.installOnQuit()).toBe(false);
	});

	it("rejects an installation that emits an error synchronously instead of throwing", async () => {
		const { updater, backend, events, onInstallFailed } = createFixture();
		const failure = new Error("Installer could not start");
		backend.quitAndInstall.mockImplementation(() => {
			events.emit("error", failure);
		});
		await updater.check();
		await updater.download();
		await expect(updater.install()).rejects.toBe(failure);
		expect(onInstallFailed).toHaveBeenCalledExactlyOnceWith(failure);
	});

	it("keeps failed checks and downloads retryable without treating them as no update", async () => {
		const { updater, backend, onInstallFailed } = createFixture();
		backend.checkForUpdates.mockRejectedValueOnce(new Error("Update server unavailable"));
		await expect(updater.check()).rejects.toThrow("Update server unavailable");
		expect(updater.getState().event).toMatchObject({ type: "error" });
		await updater.check();
		backend.downloadUpdate.mockRejectedValueOnce(new Error("Download interrupted"));
		await expect(updater.download()).rejects.toThrow("Download interrupted");
		expect(updater.getState().event).toEqual({ type: "error", message: "Download interrupted" });
		await updater.check();
		await updater.download();
		await updater.check();
		expect(backend.checkForUpdates).toHaveBeenCalledTimes(3);
		expect(updater.getState().event).toEqual({ type: "downloaded", version: info.version });
		expect(onInstallFailed).not.toHaveBeenCalled();
	});

	it("drains a pending check and cancels the token returned after shutdown starts", async () => {
		const { updater, backend, events, received } = createFixture();
		await updater.setAutoDownload(true);
		const checking = Promise.withResolvers<UpdateCheckResult>();
		const cancel = vi.fn();
		const token = { cancel } as unknown as NonNullable<UpdateCheckResult["cancellationToken"]>;
		backend.checkForUpdates.mockImplementationOnce(() => checking.promise);
		const request = updater.check();
		const stopping = updater.stop();
		expect(updater.stop()).toBe(stopping);
		await expect(updater.check()).rejects.toThrow("shutting down");
		events.emit("update-available", info);
		checking.resolve({ ...available, cancellationToken: token });
		await Promise.all([request, stopping]);
		expect(cancel).toHaveBeenCalledOnce();
		expect(received).toEqual([]);
		expect(backend.downloadUpdate).not.toHaveBeenCalled();
	});
});
