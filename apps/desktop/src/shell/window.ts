import { shellProcedures } from "@ling/contracts/api/shell-procedures";
import type { ThemeSource } from "@ling/contracts/application";
import type { HostConnectionInfo } from "@ling/contracts/host-shell";
import type { SessionRef } from "@ling/contracts/session";
import { supportsWindowsAcrylicBuild } from "@ling/contracts/api/shell-api";
import { createRuntimeLifetime } from "@ling/node-runtime/runtime-lifetime";
import { BrowserWindow, Menu, nativeTheme, screen } from "electron";
import { release } from "node:os";
import {
	DESKTOP_WINDOW_MIN_SIZE,
	loadWindowState,
	saveWindowState,
	type DesktopWindowState,
} from "../state/window-state";
import { parseAppUrl } from "./protocol-url";
import { createRendererPolicy } from "./renderer-policy";
const WINDOW_DEFAULT_SIZE = { width: 1_280, height: 800 } as const;

/** A 250 ms window-state debounce avoids filesystem writes for every native resize frame. */
const WINDOW_STATE_DEBOUNCE_MS = 250;

const WINDOW_BACKGROUND_LIGHT = "#ffffff";

const WINDOW_BACKGROUND_DARK = "#0b0b0d";

/** Electron's 14px macOS controls begin at y=15, centering them on Ling's 44px top row. */
const MAC_TRAFFIC_LIGHT_POSITION = { x: 12, y: 15 } as const;

/** Match Ling's 44px Web title strip so Windows caption buttons share its center line and hit area. */
const WINDOWS_TITLE_BAR_OVERLAY_HEIGHT = 44;
interface WindowOptions {
	userDataDirectory: string;
	preloadPath: string;
	isClosing(): boolean;
	keepRunning(): boolean;
	getHostConnection(): HostConnectionInfo | null;
	onFailure(error: unknown): void;
	onRenderingFailure(): void;
}
export function createDesktopWindow(options: WindowOptions) {
	let mainWindow: BrowserWindow | null = null;
	let pendingActivation: SessionRef | null = null;
	let hostWebOrigin: string | null = null;
	let titlebarForeground: string | null = null;
	let stateSaveTimer: ReturnType<typeof setTimeout> | null = null;
	let stateSaveTail: Promise<void> = Promise.resolve();
	const policy = createRendererPolicy({ getWindow: windowAvailable, getHostOrigin: () => hostWebOrigin });
	const { openExternalNavigation } = policy;
	const lifetime = createRuntimeLifetime(["state", "native"]);
	lifetime.defer("state", "window bounds", flushWindowState);
	lifetime.defer("native", "theme listener", () => {
		nativeTheme.off("updated", applyNativeWindowAppearance);
	});
	lifetime.defer("native", "renderer permissions", policy.dispose);
	// The process exit owner retains the window for a possible fatal-error sheet until app.quit/app.exit.
	lifetime.defer("native", "pending activation", () => {
		pendingActivation = null;
	});
	function windowAvailable(): BrowserWindow | null {
		return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
	}

	function sendRendererEvent(channel: string, value: unknown): void {
		const window = windowAvailable();
		if (window && !window.webContents.isDestroyed()) window.webContents.send(channel, value);
	}

	function applyWindowsTitleBarOverlay(): void {
		if (process.platform !== "win32") return;
		windowAvailable()?.setTitleBarOverlay({
			color: "#00000000",
			symbolColor: titlebarForeground ?? (nativeTheme.shouldUseDarkColors ? "#ffffff" : "#1a1c1f"),
			height: WINDOWS_TITLE_BAR_OVERLAY_HEIGHT,
		});
	}

	function supportsWindowsAcrylic(): boolean {
		return process.platform === "win32" && supportsWindowsAcrylicBuild(release());
	}

	function usesNativeWindowMaterial(): boolean {
		return process.platform === "darwin" || supportsWindowsAcrylic();
	}

	function applyNativeWindowAppearance(): void {
		applyWindowsTitleBarOverlay();
		const window = windowAvailable();
		if (!window || usesNativeWindowMaterial()) return;
		window.setBackgroundColor(nativeTheme.shouldUseDarkColors ? WINDOW_BACKGROUND_DARK : WINDOW_BACKGROUND_LIGHT);
	}

	function showWindow(): void {
		if (options.isClosing()) return;
		const window = windowAvailable();
		if (!window) {
			const connection = options.getHostConnection();
			if (connection) void createWindow(connection).catch(options.onFailure);
			return;
		}
		if (window.isMinimized()) window.restore();
		window.show();
		window.focus();
	}

	function sendActivation(ref: SessionRef): void {
		const window = windowAvailable();
		if (!window || window.webContents.isLoadingMainFrame()) {
			pendingActivation = { ...ref };
			return;
		}
		sendRendererEvent(shellProcedures.lifecycle.onActivateSession.channel, ref);
	}

	function activateSession(ref: SessionRef): void {
		if (options.isClosing()) return;
		pendingActivation = { ...ref };
		showWindow();
		const activation = pendingActivation;
		if (!activation) return;
		pendingActivation = null;
		sendActivation(activation);
	}

	function handleAppUrl(value: string): void {
		const ref = parseAppUrl(value);
		if (!ref) {
			console.warn(`Ignored unsupported Ling URL: ${value.slice(0, 200)}`);
			return;
		}
		activateSession(ref);
	}

	function captureWindowState(window: BrowserWindow): DesktopWindowState {
		return { ...window.getNormalBounds(), maximized: window.isMaximized() };
	}

	function enqueueWindowStateSave(state: DesktopWindowState): void {
		stateSaveTail = stateSaveTail.then(
			() => saveWindowState(options.userDataDirectory, state),
			() => saveWindowState(options.userDataDirectory, state),
		);
		void stateSaveTail.catch((error: unknown) => console.error("Could not save Ling window state", error));
	}

	function scheduleWindowStateSave(): void {
		if (options.isClosing()) return;
		if (stateSaveTimer) clearTimeout(stateSaveTimer);
		stateSaveTimer = setTimeout(() => {
			stateSaveTimer = null;
			const window = windowAvailable();
			if (!window) return;
			enqueueWindowStateSave(captureWindowState(window));
		}, WINDOW_STATE_DEBOUNCE_MS);
	}

	async function flushWindowState(): Promise<void> {
		if (stateSaveTimer) {
			clearTimeout(stateSaveTimer);
			stateSaveTimer = null;
		}
		const window = windowAvailable();
		if (window) enqueueWindowStateSave(captureWindowState(window));
		await stateSaveTail;
	}

	function fitWindowStateToCurrentDisplay(state: DesktopWindowState): DesktopWindowState {
		const { workArea } = screen.getDisplayMatching(state);
		const width = Math.min(state.width, workArea.width);
		const height = Math.min(state.height, workArea.height);
		return {
			x: Math.max(workArea.x, Math.min(state.x, workArea.x + workArea.width - width)),
			y: Math.max(workArea.y, Math.min(state.y, workArea.y + workArea.height - height)),
			width,
			height,
			maximized: state.maximized,
		};
	}

	async function createWindow(connection: HostConnectionInfo): Promise<void> {
		if (options.isClosing() || windowAvailable()) return;
		const saved = await loadWindowState(options.userDataDirectory);
		// Activation can overlap the state read or arrive while the Host is draining.
		if (options.isClosing() || windowAvailable()) return;
		const restored = saved ? fitWindowStateToCurrentDisplay(saved) : null;
		const origin = new URL(connection.url);
		origin.protocol = origin.protocol === "wss:" ? "https:" : "http:";
		origin.pathname = "/";
		origin.search = "";
		origin.hash = "";
		hostWebOrigin = origin.origin;
		const translucentMaterial = usesNativeWindowMaterial();
		const window = new BrowserWindow({
			title: "Ling",
			width: restored?.width ?? WINDOW_DEFAULT_SIZE.width,
			height: restored?.height ?? WINDOW_DEFAULT_SIZE.height,
			...(restored ? { x: restored.x, y: restored.y } : {}),
			minWidth: DESKTOP_WINDOW_MIN_SIZE.width,
			minHeight: DESKTOP_WINDOW_MIN_SIZE.height,
			show: false,
			backgroundColor: translucentMaterial
				? "#00000000"
				: nativeTheme.shouldUseDarkColors
					? WINDOW_BACKGROUND_DARK
					: WINDOW_BACKGROUND_LIGHT,
			titleBarStyle:
				process.platform === "darwin" ? "hiddenInset" : process.platform === "win32" ? "hidden" : "default",
			...(process.platform === "darwin"
				? {
						trafficLightPosition: MAC_TRAFFIC_LIGHT_POSITION,
						vibrancy: "sidebar" as const,
						visualEffectState: "active" as const,
					}
				: {}),
			...(process.platform === "win32"
				? {
						titleBarOverlay: {
							color: "#00000000",
							symbolColor: nativeTheme.shouldUseDarkColors ? "#ffffff" : "#1a1c1f",
							height: WINDOWS_TITLE_BAR_OVERLAY_HEIGHT,
						},
						...(supportsWindowsAcrylic() ? { backgroundMaterial: "acrylic" as const } : {}),
					}
				: {}),
			webPreferences: {
				preload: options.preloadPath,
				contextIsolation: true,
				sandbox: true,
				nodeIntegration: false,
				spellcheck: true,
			},
		});
		mainWindow = window;
		applyNativeWindowAppearance();
		if (restored?.maximized) window.maximize();
		let initialWindowShown = false;
		const showInitialWindow = (): void => {
			if (initialWindowShown || options.isClosing() || window.isDestroyed()) return;
			initialWindowShown = true;
			window.show();
		};
		window.once("ready-to-show", showInitialWindow);
		window.on("focus", () => window.flashFrame(false));
		window.on("move", scheduleWindowStateSave);
		window.on("resize", scheduleWindowStateSave);
		window.on("close", (event) => {
			if (options.isClosing() || !options.keepRunning()) return;
			event.preventDefault();
			window.hide();
		});
		window.on("closed", () => {
			if (mainWindow === window) mainWindow = null;
		});
		window.webContents.on("did-finish-load", () => {
			showInitialWindow();
			const activation = pendingActivation;
			if (!activation) return;
			pendingActivation = null;
			sendActivation(activation);
		});
		window.webContents.on("will-prevent-unload", (event) => event.preventDefault());
		window.webContents.on("render-process-gone", (_event, details) => {
			console.error(`Electron renderer process exited: reason=${details.reason} exitCode=${details.exitCode}`);
			if (details.reason === "clean-exit" || window.isDestroyed() || options.isClosing()) return;
			options.onRenderingFailure();
			window.webContents.reload();
		});
		window.webContents.on("context-menu", (_event, parameters) => {
			const { editFlags } = parameters;
			const template = parameters.isEditable
				? [
						{ role: "cut" as const, enabled: editFlags.canCut },
						{ role: "copy" as const, enabled: editFlags.canCopy },
						{ role: "paste" as const, enabled: editFlags.canPaste },
					]
				: parameters.selectionText.trim()
					? [{ role: "copy" as const }]
					: [];
			if (template.length > 0) Menu.buildFromTemplate(template).popup({ window });
		});
		window.webContents.setWindowOpenHandler(({ url }) => {
			openExternalNavigation(url);
			return { action: "deny" };
		});
		window.webContents.on("will-navigate", (event, target) => {
			if (new URL(target).origin === hostWebOrigin) return;
			event.preventDefault();
			openExternalNavigation(target);
		});
		try {
			await window.loadURL(origin.href);
		} catch (error) {
			// An admitted shutdown may destroy the window before its navigation settles.
			if (!options.isClosing()) throw error;
		}
	}
	return {
		get: windowAvailable,
		create: createWindow,
		show: showWindow,
		activate: activateSession,
		handleAppUrl,
		send: sendRendererEvent,
		initialize() {
			policy.installPermissionPolicy();
			nativeTheme.on("updated", applyNativeWindowAppearance);
		},
		async reconnect(connection: HostConnectionInfo) {
			const window = windowAvailable();
			if (!window) return createWindow(connection);
			const url = new URL(connection.url);
			url.protocol = url.protocol === "wss:" ? "https:" : "http:";
			url.pathname = "/";
			url.search = "";
			url.hash = "";
			hostWebOrigin = url.origin;
			await window.loadURL(url.href);
		},
		setTheme(source: ThemeSource, foreground: string | null) {
			titlebarForeground = foreground;
			nativeTheme.themeSource = source;
			applyWindowsTitleBarOverlay();
		},
		setZoomFactor(factor: number) {
			windowAvailable()?.webContents.setZoomFactor(factor);
		},
		dispose: lifetime.dispose,
	};
}
