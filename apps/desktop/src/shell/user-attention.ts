import type { HostNotificationKind, HostShellEvent } from "@ling/contracts/host-shell";
import type { UiLanguage } from "@ling/contracts/application";
import type { SessionRef } from "@ling/contracts/session";
import { sessionKey } from "@ling/contracts/session-ref";
import { createRuntimeLifetime } from "@ling/node-runtime/runtime-lifetime";
import { app, Menu, nativeImage, Notification, powerSaveBlocker, Tray, type BrowserWindow } from "electron";
import { basename, join } from "node:path";
import { nativeMenuCopy } from "./native-menu";
import {
	loadRecentProjects,
	saveRecentProjects,
	updateRecentProjects,
	type RecentProject,
} from "../state/recent-projects";
/**
 * Single owner of every platform attention surface: session toast notifications, window
 * attention requests, unread completion badges, and Windows taskbar run progress.
 * Each platform branch lives here so call sites never branch on process.platform.
 */

interface SessionNotificationEvent {
	ref: SessionRef;
	title: string;
	body: string;
	silent: boolean;
	kind: HostNotificationKind;
}

function sameSession(left: SessionRef | null, right: SessionRef): boolean {
	return left !== null && left.cwd === right.cwd && left.sessionId === right.sessionId;
}

/** Windows taskbar overlay badges render at 16×16 DIP; 32×32 pixels keep them crisp at 200% DPI. */
const BADGE_BITMAP_SIZE = 32;

/** Glyphs are 3×5 base cells; ×3 keeps two digits legible inside the disc. */
const BADGE_GLYPH_SCALE = 3;

const BADGE_COLOR = { blue: 0x36, green: 0x48, red: 0xd1 };

// #d13438, Fluent danger red
const DIGIT_GLYPHS: Readonly<Record<string, readonly string[]>> = {
	"0": ["111", "101", "101", "101", "111"],
	"1": ["010", "110", "010", "010", "111"],
	"2": ["111", "001", "111", "100", "111"],
	"3": ["111", "001", "011", "001", "111"],
	"4": ["101", "101", "111", "001", "001"],
	"5": ["111", "100", "111", "001", "111"],
	"6": ["111", "100", "111", "101", "111"],
	"7": ["111", "001", "001", "001", "001"],
	"8": ["111", "101", "111", "101", "111"],
	"9": ["111", "101", "111", "001", "111"],
	"+": ["000", "010", "111", "010", "000"],
};

function drawBadgePixel(buffer: Buffer, x: number, y: number, color: typeof BADGE_COLOR, alpha = 255): void {
	const offset = (y * BADGE_BITMAP_SIZE + x) * 4;
	buffer.writeUInt8(color.blue, offset);
	buffer.writeUInt8(color.green, offset + 1);
	buffer.writeUInt8(color.red, offset + 2);
	buffer.writeUInt8(alpha, offset + 3);
}

function renderBadgeOverlay(count: number): Electron.NativeImage {
	const size = BADGE_BITMAP_SIZE;
	const buffer = Buffer.alloc(size * size * 4, 0);
	const center = (size - 1) / 2;
	const radius = center;
	for (let y = 0; y < size; y += 1) {
		for (let x = 0; x < size; x += 1) {
			const dx = x - center;
			const dy = y - center;
			if (dx * dx + dy * dy <= radius * radius) drawBadgePixel(buffer, x, y, BADGE_COLOR);
		}
	}
	const text = count > 9 ? "9+" : String(count);
	const glyphWidth = 3 * BADGE_GLYPH_SCALE;
	const textWidth = text.length * glyphWidth + (text.length - 1) * BADGE_GLYPH_SCALE;
	const textHeight = 5 * BADGE_GLYPH_SCALE;
	const originX = Math.round((size - textWidth) / 2);
	const originY = Math.round((size - textHeight) / 2);
	for (const [index, char] of [...text].entries()) {
		const glyph = DIGIT_GLYPHS[char];
		if (!glyph) continue;
		const baseX = originX + index * (glyphWidth + BADGE_GLYPH_SCALE);
		for (const [row, bits] of glyph.entries()) {
			for (const [column, bit] of [...bits].entries()) {
				if (bit !== "1") continue;
				for (let dy = 0; dy < BADGE_GLYPH_SCALE; dy += 1) {
					for (let dx = 0; dx < BADGE_GLYPH_SCALE; dx += 1) {
						drawBadgePixel(buffer, baseX + column * BADGE_GLYPH_SCALE + dx, originY + row * BADGE_GLYPH_SCALE + dy, {
							blue: 255,
							green: 255,
							red: 255,
						});
					}
				}
			}
		}
	}
	return nativeImage.createFromBitmap(buffer, { width: size, height: size });
}
interface AttentionOptions {
	getWindow(): BrowserWindow | null;
	showWindow(): void;
	activateSession(ref: SessionRef): void;
	appResourcesRoot: string;
	userDataDirectory: string;
}
export function createDesktopAttention(options: AttentionOptions) {
	const lifetime = createRuntimeLifetime(["native", "storage"]);
	let stopped = false;
	let viewedSession: SessionRef | null = null;
	let keepRunningOnWindowClose = false;
	let keepAwakeEnabled = false;
	let keepAwakeBlockerId: number | null = null;
	const runningSessions = new Set<string>();
	let tray: Tray | null = null;
	let language: UiLanguage = "en";
	let recentProjects: RecentProject[] = [];
	let recentProjectsSaveTail: Promise<void> = Promise.resolve();
	let lastOverlayCount = -1;
	const unreadSessions = new Set<string>();
	const notifications = new Set<Notification>();
	function requestPlatformAttention(): void {
		if (process.platform === "darwin") app.dock?.bounce("informational");
		else if (process.platform === "win32") options.getWindow()?.flashFrame(true);
	}

	/**
	 * Shows a session toast unless that session is already on screen in a focused window.
	 * macOS requires a signed app; Windows requires an installed Start Menu shortcut carrying
	 * the app's AppUserModelID (electron-builder writes `appId`). Development builds can be
	 * rejected by the OS; delivery failures remain observable and flash/bounce still run.
	 */
	function presentSessionNotification(
		event: SessionNotificationEvent,
		viewedSession: SessionRef | null,
		onActivate: (ref: SessionRef) => void,
	): void {
		const window = options.getWindow();
		if (window?.isFocused() && window.isVisible() && sameSession(viewedSession, event.ref)) return;
		if (event.kind === "backgroundCompletion") noteUnreadSession(event.ref);
		requestPlatformAttention();
		if (!Notification.isSupported()) return;
		const notification = new Notification({ title: event.title, body: event.body, silent: event.silent });
		// Keep native notification handles bounded until the OS closes them or this owner shuts down.
		if (notifications.size >= 64) {
			const oldest = notifications.values().next().value;
			if (oldest) {
				oldest.close();
				notifications.delete(oldest);
			}
		}
		notifications.add(notification);
		notification.on("close", () => notifications.delete(notification));
		notification.on("click", () => {
			if (!stopped) onActivate(event.ref);
		});
		notification.on("failed", (_event, error) => {
			console.warn(`[user-attention] notification failed: ${error}`);
		});
		try {
			notification.show();
		} catch (error) {
			console.warn("[user-attention] notification could not be shown:", error);
		}
	}

	function updateUnreadSessionBadge(count: number): void {
		if (process.platform === "darwin") {
			app.dock?.setBadge(count > 0 ? String(count) : "");
			return;
		}
		if (process.platform === "linux") {
			app.setBadgeCount(count);
			return;
		}
		if (process.platform !== "win32") return;
		const window = options.getWindow();
		if (!window) return;
		if (count === lastOverlayCount) return;
		lastOverlayCount = count;
		if (count > 0) {
			const labels: Record<UiLanguage, string> = {
				en: `${count} unread session${count === 1 ? "" : "s"}`,
				"zh-CN": `${count} 个未读会话`,
				ja: `${count} 件の未読会話`,
				ko: `읽지 않은 대화 ${count}개`,
			};
			window.setOverlayIcon(renderBadgeOverlay(count), labels[language]);
		} else window.setOverlayIcon(null, "");
	}

	function noteUnreadSession(ref: SessionRef): void {
		unreadSessions.add(sessionKey(ref));
		updateUnreadSessionBadge(unreadSessions.size);
	}

	/** Clears the Dock/taskbar badge for a session the user is now looking at. */
	function clearViewedSessionAttention(ref: SessionRef | null): void {
		if (ref === null) return;
		if (!unreadSessions.delete(sessionKey(ref))) return;
		updateUnreadSessionBadge(unreadSessions.size);
	}

	function resetSessionAttention(): void {
		if (unreadSessions.size === 0 && lastOverlayCount <= 0) return;
		unreadSessions.clear();
		updateUnreadSessionBadge(0);
	}

	/**
	 * Windows taskbar indeterminate progress while any agent run is in flight.
	 * macOS `setProgressBar` is a determinate Dock bar and must not be used as a spinner.
	 */
	function updateAgentRunProgress(runningCount: number): void {
		if (process.platform !== "win32") return;
		options.getWindow()?.setProgressBar(runningCount > 0 ? 2 : -1);
	}
	function refreshKeepAwake(): void {
		const shouldBlock = keepAwakeEnabled && runningSessions.size > 0;
		if (shouldBlock && keepAwakeBlockerId === null) {
			keepAwakeBlockerId = powerSaveBlocker.start("prevent-display-sleep");
			return;
		}
		if (!shouldBlock && keepAwakeBlockerId !== null) {
			if (powerSaveBlocker.isStarted(keepAwakeBlockerId)) powerSaveBlocker.stop(keepAwakeBlockerId);
			keepAwakeBlockerId = null;
		}
	}

	function applyDevelopmentDockIcon(): void {
		if (process.platform !== "darwin" || app.isPackaged) return;
		const dock = app.dock;
		if (!dock) throw new Error("Electron did not expose the macOS Dock API");
		const icon = nativeImage.createFromPath(join(options.appResourcesRoot, "icon.png"));
		if (icon.isEmpty()) throw new Error("Ling development Dock icon could not be loaded");
		dock.setIcon(icon);
	}

	function refreshTrayMenu(): void {
		const copy = nativeMenuCopy[language];
		tray?.setContextMenu(
			Menu.buildFromTemplate([
				{ label: copy.showLing, click: options.showWindow },
				{ type: "separator" },
				{ label: copy.quit, role: "quit" },
			]),
		);
	}
	function installWindowsTray(): void {
		if (process.platform !== "win32") return;
		const icon = nativeImage.createFromPath(join(options.appResourcesRoot, "icon.png"));
		if (icon.isEmpty()) throw new Error("Ling Windows tray icon could not be loaded");
		tray = new Tray(icon);
		tray.setToolTip("Ling");
		refreshTrayMenu();
		tray.on("click", options.showWindow);
	}

	function trackViewedProject(ref: SessionRef): void {
		if (stopped) return;
		const updated = updateRecentProjects(recentProjects, ref);
		if (updated === recentProjects) return;
		recentProjects = updated;
		recentProjectsSaveTail = recentProjectsSaveTail.then(
			() => saveRecentProjects(options.userDataDirectory, updated),
			() => saveRecentProjects(options.userDataDirectory, updated),
		);
		void recentProjectsSaveTail.then(
			() => refreshJumpList(updated),
			(error: unknown) => console.error("Could not save Ling recent projects", error),
		);
	}

	function appUrlFor(ref: SessionRef): string {
		const url = new URL("ling://session");
		url.searchParams.set("cwd", ref.cwd);
		url.searchParams.set("id", ref.sessionId);
		return url.toString();
	}

	function refreshJumpList(projects: readonly RecentProject[]): void {
		if (process.platform !== "win32") return;
		const items = projects.map((project) => ({
			type: "task" as const,
			title: basename(project.cwd) || project.cwd,
			description: project.cwd,
			program: process.execPath,
			args: appUrlFor(project),
			iconPath: process.execPath,
			iconIndex: 0,
		}));
		app.setJumpList(items.length > 0 ? [{ type: "custom", name: nativeMenuCopy[language].recentProjects, items }] : []);
	}
	function clearActivity() {
		runningSessions.clear();
		resetSessionAttention();
		updateAgentRunProgress(0);
		refreshKeepAwake();
	}
	lifetime.onStop("attention admission", () => {
		stopped = true;
	});
	lifetime.defer("native", "notifications", async () => {
		const outcomes = await Promise.allSettled([...notifications].map(async (notification) => notification.close()));
		notifications.clear();
		const failures = outcomes.flatMap((o) => (o.status === "rejected" ? [o.reason] : []));
		if (failures.length) throw new AggregateError(failures, "Native notification cleanup failed");
	});
	lifetime.defer("native", "badges", resetSessionAttention);
	lifetime.defer("native", "progress", () => updateAgentRunProgress(0));
	lifetime.defer("native", "keep awake", () => {
		keepAwakeEnabled = false;
		runningSessions.clear();
		refreshKeepAwake();
	});
	lifetime.defer("native", "tray", () => {
		tray?.destroy();
		tray = null;
	});
	lifetime.defer("storage", "recent projects", () => recentProjectsSaveTail);
	return {
		setLanguage(nextLanguage: UiLanguage) {
			if (stopped || nextLanguage === language) return;
			language = nextLanguage;
			refreshTrayMenu();
			refreshJumpList(recentProjects);
			lastOverlayCount = -1;
			updateUnreadSessionBadge(unreadSessions.size);
		},
		async initialize() {
			applyDevelopmentDockIcon();
			const loaded = await loadRecentProjects(options.userDataDirectory);
			if (stopped) return;
			recentProjects = loaded;
			refreshJumpList(recentProjects);
		},
		installTray: installWindowsTray,
		keepRunning: () => keepRunningOnWindowClose,
		setViewedSession(ref: SessionRef | null) {
			viewedSession = ref;
			if (ref) trackViewedProject(ref);
			clearViewedSessionAttention(ref);
		},
		focused() {
			clearViewedSessionAttention(viewedSession);
		},
		clearActivity,
		handleEvent(event: Exclude<HostShellEvent, { type: "graphicsPreference" }>) {
			if (stopped) return;
			switch (event.type) {
				case "keepRunningPreference":
					keepRunningOnWindowClose = event.enabled;
					break;
				case "keepAwakePreference":
					keepAwakeEnabled = event.enabled;
					refreshKeepAwake();
					break;
				case "agentRunState": {
					const key = sessionKey(event.ref);
					if (event.running) runningSessions.add(key);
					else runningSessions.delete(key);
					refreshKeepAwake();
					updateAgentRunProgress(runningSessions.size);
					break;
				}
				default:
					presentSessionNotification(event, viewedSession, options.activateSession);
			}
		},
		stop: lifetime.stop,
		dispose: lifetime.dispose,
	};
}
