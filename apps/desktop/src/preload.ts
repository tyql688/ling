import { createShellProcedureClient } from "@ling/contracts/api/shell-procedures";
import type { AppPlatform } from "@ling/contracts/application";
import { PROJECT_FILE_REFERENCE_MAX_ITEMS } from "@ling/contracts/project";
import type { ExtensionTerminalInputReplayRequest } from "@ling/contracts/session";
import {
	type ShellApi,
	type ShellNotificationPermission,
	supportsWindowsAcrylicBuild,
} from "@ling/contracts/api/shell-api";
import { contextBridge, ipcRenderer, webUtils } from "electron";

function platform(): AppPlatform {
	if (process.platform === "darwin" || process.platform === "win32" || process.platform === "linux") {
		return process.platform;
	}
	return "other";
}

function windowTranslucencyAvailable(): boolean {
	if (process.platform === "darwin") return true;
	return process.platform === "win32" && supportsWindowsAcrylicBuild(process.getSystemVersion());
}

function notificationPermission(): ShellNotificationPermission {
	if (!("Notification" in window)) return "unsupported";
	if (Notification.permission === "default") return "not-determined";
	return Notification.permission;
}

function modifiers(request: Extract<ExtensionTerminalInputReplayRequest, { type: "keyDown" | "keyUp" | "char" }>) {
	return {
		altKey: request.modifiers.includes("alt"),
		ctrlKey: request.modifiers.includes("control"),
		shiftKey: request.modifiers.includes("shift"),
	};
}

function insertText(text: string): void {
	const target = document.activeElement;
	if (!(target instanceof HTMLElement)) throw new Error("No active editor can receive replayed text input");
	const beforeInput = new InputEvent("beforeinput", {
		bubbles: true,
		cancelable: true,
		composed: true,
		data: text,
		inputType: "insertText",
	});
	if (!target.dispatchEvent(beforeInput)) return;
	if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
		const start = target.selectionStart;
		const end = target.selectionEnd;
		if (start === null || end === null) throw new Error("The active text control has no selection range");
		target.setRangeText(text, start, end, "end");
	} else if (target.isContentEditable) {
		const selection = window.getSelection();
		if (!selection || selection.rangeCount !== 1) throw new Error("The active editor has no insertion range");
		const range = selection.getRangeAt(0);
		range.deleteContents();
		const inserted = document.createTextNode(text);
		range.insertNode(inserted);
		range.setStartAfter(inserted);
		range.collapse(true);
		selection.removeAllRanges();
		selection.addRange(range);
	} else {
		throw new Error("The active element is not editable");
	}
	target.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, data: text, inputType: "insertText" }));
}

function replayInput(request: ExtensionTerminalInputReplayRequest): Promise<void> {
	const target = document.activeElement;
	if (!(target instanceof HTMLElement)) return Promise.reject(new Error("No active editor can receive replayed input"));
	if (request.type === "insertText" || request.type === "char") {
		insertText(request.type === "insertText" ? request.text : request.keyCode);
		return Promise.resolve();
	}
	const event = new KeyboardEvent(request.type === "keyDown" ? "keydown" : "keyup", {
		bubbles: true,
		cancelable: true,
		composed: true,
		key: request.keyCode,
		code: request.keyCode,
		...modifiers(request),
	});
	target.dispatchEvent(event);
	return Promise.resolve();
}

function subscribe<Value>(channel: string, callback: (value: Value) => void): () => void {
	const listener = (_event: Electron.IpcRendererEvent, value: Value): void => callback(value);
	ipcRenderer.on(channel, listener);
	return () => ipcRenderer.removeListener(channel, listener);
}

const client = createShellProcedureClient({
	invoke: (channel, args) => ipcRenderer.invoke(channel, ...args),
	subscribe,
});
const shell: ShellApi = {
	capabilities: {
		directoryPicker: true,
		droppedFilePaths: true,
		nativePathOpen: true,
		nativePathReveal: true,
		systemPermissions: true,
		updates: true,
		nativeNotifications: true,
		notificationPermissionRequest: "Notification" in window,
		windowClosePersistence: true,
		hardwareAccelerationControl: false,
		screenWakeLock: true,
		windowTranslucency: windowTranslucencyAvailable(),
		nativeLanguageSync: true,
		extensionInputReplay: true,
	},
	environment: { home: null, platform: platform() },
	host: client.host,
	lifecycle: {
		...client.lifecycle,
		handleHostEvent: () => undefined,
	},
	app: {
		...client.app,
		getNotificationPermission: () => Promise.resolve(notificationPermission()),
		requestNotificationPermission: async () => {
			if (!("Notification" in window)) return "unsupported";
			await Notification.requestPermission();
			return notificationPermission();
		},
	},
	window: { ...client.window, setTheme: (source, foreground) => client.window.setTheme({ source, foreground }) },
	filesystem: {
		...client.filesystem,
		getDroppedFilePaths: (files) => {
			if (files.length > PROJECT_FILE_REFERENCE_MAX_ITEMS) return Promise.reject(new Error("Too many dropped files"));
			return Promise.resolve(files.map((file) => webUtils.getPathForFile(file) || null));
		},
	},
	input: { replayExtensionTerminalInput: replayInput },
	updates: client.updates,
};

contextBridge.exposeInMainWorld("lingShell", Object.freeze(shell));
