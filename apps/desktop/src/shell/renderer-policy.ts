import { externalWebUrlSchema } from "@ling/contracts/shell-validation";
import { toError } from "@ling/contracts/ling-error";
import { type BrowserWindow, dialog, session, shell, type WebContents } from "electron";

interface RendererPolicyOptions {
	getWindow(): BrowserWindow | null;
	getHostOrigin(): string | null;
}
export function createRendererPolicy(options: RendererPolicyOptions) {
	let installed = false;
	function isTrustedRendererRequest(
		webContents: WebContents | null,
		requestingUrl: string | undefined,
		isMainFrame: boolean,
	): boolean {
		const window = options.getWindow();
		if (!window || webContents !== window.webContents || !isMainFrame || requestingUrl === undefined) return false;
		try {
			const origin = options.getHostOrigin();
			return origin !== null && new URL(requestingUrl).origin === origin;
		} catch {
			return false;
		}
	}

	function isAllowedRendererPermission(
		webContents: WebContents | null,
		permission: string,
		requestingUrl: string | undefined,
		isMainFrame: boolean,
	): boolean {
		if (permission !== "clipboard-sanitized-write" && permission !== "notifications") return false;
		return isTrustedRendererRequest(webContents, requestingUrl, isMainFrame);
	}

	function installPermissionPolicy(): void {
		installed = true;
		session.defaultSession.setPermissionCheckHandler((webContents, permission, _origin, details) =>
			isAllowedRendererPermission(webContents, permission, details.requestingUrl, details.isMainFrame),
		);
		session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
			callback(isAllowedRendererPermission(webContents, permission, details.requestingUrl, details.isMainFrame));
		});
	}

	function openExternalNavigation(value: string): void {
		const parsed = externalWebUrlSchema.safeParse(value);
		if (!parsed.success) return;
		void shell.openExternal(parsed.data).catch((error: unknown) => {
			const normalized = toError(error);
			console.error("Could not open external navigation", normalized);
			dialog.showErrorBox("Ling could not open the link", normalized.message);
		});
	}

	return {
		installPermissionPolicy,
		openExternalNavigation,
		dispose() {
			if (!installed) return;
			installed = false;
			session.defaultSession.setPermissionCheckHandler(() => false);
			session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
		},
	};
}
