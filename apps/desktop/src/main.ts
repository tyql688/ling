import { shellProcedures } from "@ling/contracts/api/shell-procedures";
import { createRuntimeLifetime } from "@ling/node-runtime/runtime-lifetime";
import { app, dialog, shell } from "electron";
import electronUpdater from "electron-updater";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createDesktopHostSupervisor } from "./host/host-supervisor";
import { createDesktopGraphics } from "./shell/graphics";
import { createDesktopIpc, nativeAbsolutePathSchema } from "./shell/ipc";
import { installDesktopLog } from "./shell/log-file-sink";
import { setDesktopMenuLanguage } from "./shell/native-menu";
import { createDesktopShutdown } from "./shell/shutdown";
import {
	getSystemPermissionState,
	openSystemPermissionSettings,
	requestSystemPermission,
} from "./shell/system-permissions";
import { createDesktopUpdater } from "./shell/updater";
import { createDesktopAttention } from "./shell/user-attention";
import { createDesktopWindow } from "./shell/window";

declare const __LING_VERSION__: string;

function startDesktop(): void {
	const lifetime = createRuntimeLifetime(["admission", "native", "host", "storage"]);
	let windowOwner: ReturnType<typeof createDesktopWindow> | null = null;
	const getWindow = () => windowOwner?.get() ?? null;
	const shutdown = createDesktopShutdown({
		getWindow,
		dispose: lifetime.dispose,
		finishGraphics: () => graphics.finishCleanRun(),
		installOnQuit: () => updater.installOnQuit(),
	});
	process.on("uncaughtException", shutdown.reportFailure);
	process.on("unhandledRejection", shutdown.reportFailure);
	app.setName("Ling");
	const override = process.env.LING_USER_DATA_DIR;
	if (override) app.setPath("userData", nativeAbsolutePathSchema.parse(override));
	const userDataDirectory = app.getPath("userData");
	const appResourcesRoot = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), ".stage");
	const desktopLog = installDesktopLog(join(userDataDirectory, "logs", "desktop"));
	app.setAppUserModelId("dev.ling.desktop");
	app.enableSandbox();
	const graphics = createDesktopGraphics({
		userDataDirectory,
		getWindow,
		relaunch: () => shutdown.quit(true),
		onFailure: shutdown.reportFailure,
	});
	lifetime.onStop("graphics admission", graphics.stop);
	lifetime.defer("storage", "graphics state", graphics.dispose);
	const updater = createDesktopUpdater({
		updater: electronUpdater.autoUpdater,
		appVersion: __LING_VERSION__,
		supported: app.isPackaged,
		prepareInstall: shutdown.prepareInstall,
		onPrepared: shutdown.completeInstall,
		onInstallFailed: shutdown.reportFailure,
		onEvent: (event) => windowOwner?.send(shellProcedures.updates.onEvent.channel, event),
	});
	lifetime.defer("native", "updater requests", updater.stop);
	app.once("quit", updater.dispose);
	const attention = createDesktopAttention({
		getWindow,
		showWindow: () => windowOwner?.show(),
		activateSession: (ref) => windowOwner?.activate(ref),
		appResourcesRoot,
		userDataDirectory,
	});
	lifetime.onStop("attention admission", attention.stop);
	lifetime.defer("native", "user attention", attention.dispose);
	const host = createDesktopHostSupervisor({
		appResourcesRoot,
		userDataDirectory,
		desktopLog,
		getWindow,
		onShellEvent: (event) => {
			if (shutdown.isClosing()) return;
			if (event.type === "graphicsPreference")
				void graphics.setPreference(event.softwareRendering).catch(shutdown.reportFailure);
			else attention.handleEvent(event);
		},
		onConnected: (connection) => window.reconnect(connection),
		onUnavailable: attention.clearActivity,
		onFailure: shutdown.reportFailure,
	});
	lifetime.onStop("Host admission", host.stop);
	lifetime.defer("host", "Host process", host.dispose);
	const window = createDesktopWindow({
		userDataDirectory,
		preloadPath: join(import.meta.dirname, "../preload/index.cjs"),
		isClosing: shutdown.isClosing,
		keepRunning: attention.keepRunning,
		getHostConnection: host.peek,
		onFailure: shutdown.reportFailure,
		onRenderingFailure: graphics.noteFailure,
	});
	windowOwner = window;
	lifetime.defer("native", "window", window.dispose);
	const ipc = createDesktopIpc({ getWindow, isClosing: shutdown.isClosing });
	lifetime.defer("admission", "shell IPC", ipc.dispose);

	async function bootstrap(): Promise<void> {
		await app.whenReady();
		if (shutdown.isClosing()) return;
		const initialLanguage = host.initializeLanguage();
		setDesktopMenuLanguage(initialLanguage);
		attention.setLanguage(initialLanguage);
		await mkdir(userDataDirectory, { recursive: true });
		if (shutdown.isClosing()) return;
		window.initialize();
		await attention.initialize();
		if (shutdown.isClosing()) return;
		ipc.register({
			host: { connection: host.connection },
			lifecycle: { setViewedSession: attention.setViewedSession },
			app: {
				openExternal: async (url) => shell.openExternal(url),
				getSystemPermission: getSystemPermissionState,
				requestSystemPermission,
				openSystemPermission: openSystemPermissionSettings,
			},
			window: {
				setZoomFactor: window.setZoomFactor,
				setTheme: (appearance) => window.setTheme(appearance.source, appearance.foreground),
				setLanguage(language) {
					host.setLanguage(language);
					setDesktopMenuLanguage(language);
					attention.setLanguage(language);
				},
			},
			filesystem: {
				chooseDirectory: async () => {
					const options: Electron.OpenDialogOptions = {
						defaultPath: app.getPath("home"),
						properties: ["openDirectory", "createDirectory"],
					};
					const parent = getWindow();
					const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
					if (result.canceled) return null;
					const selected = result.filePaths[0];
					if (!selected) throw new Error("The directory picker returned no selected directory");
					return selected;
				},
				openPath: async (path) => {
					const error = await shell.openPath(path);
					if (error) throw new Error(error);
				},
				revealPath: (path) => shell.showItemInFolder(path),
			},
			updates: {
				getState: updater.getState,
				check: updater.check,
				download: updater.download,
				install: updater.install,
			},
		});
		const launchedHost = await host.launch();
		if (shutdown.isClosing()) return;
		await window.create(launchedHost.connection);
		if (shutdown.isClosing()) return;
		attention.installTray();
		shutdown.markStarted();
		for (const argument of process.argv) if (argument.startsWith("ling://")) window.handleAppUrl(argument);
	}

	if (!app.requestSingleInstanceLock()) {
		app.quit();
		return;
	}
	app.on("second-instance", (_event, argv) => {
		const url = argv.find((argument) => argument.startsWith("ling://"));
		if (url) window.handleAppUrl(url);
		else window.show();
	});
	app.on("open-url", (event, url) => {
		event.preventDefault();
		window.handleAppUrl(url);
	});
	app.on("activate", window.show);
	app.on("browser-window-focus", attention.focused);
	app.on("window-all-closed", () => {
		if (!attention.keepRunning()) app.quit();
	});
	app.on("child-process-gone", (_event, details) => {
		console.error(`${details.type} process exited: reason=${details.reason} exitCode=${details.exitCode}`);
		if (details.type === "GPU" && details.reason !== "clean-exit") graphics.noteFailure();
	});
	app.on("before-quit", (event) => {
		if (shutdown.isComplete()) return;
		event.preventDefault();
		shutdown.quit(false);
	});
	try {
		// Electron only honors the graphics preference before app.ready.
		graphics.initialize();
		void bootstrap().catch(shutdown.reportFailure);
	} catch (error) {
		shutdown.reportFailure(error);
	}
}

startDesktop();
