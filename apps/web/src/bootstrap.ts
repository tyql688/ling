import { createLingApiClient } from "@ling/contracts/api/ling-api-client";
import { createProcedureClient } from "@ling/contracts/procedure";
import { projectProcedures } from "@ling/contracts/project-procedures";
import {
	HOST_SHELL_EVENT_CHANNEL,
	HOST_SHELL_STATE_METHOD,
	type HostShellEvent,
	type HostShellState,
} from "@ling/contracts/host-shell";
import { toError } from "@ling/contracts/ling-error";
import { createBrowserShell } from "./platform/browser-shell";
import { connectHostWebSocket } from "./platform/host-websocket-transport";

const WEB_CLIENT_ID_KEY = "ling:web-client-id";
const WEB_TOKEN_STORAGE_KEY = "ling:web-host-token";
const WEB_TOKEN_FRAGMENT_KEY = "token";
const WEB_SOCKET_PATH = "/api/ws";

function showBootstrapError(error: Error): void {
	const startup = document.getElementById("ling-startup");
	startup?.remove();
	const root = document.getElementById("root");
	if (!root) throw error;
	root.replaceChildren();
	const panel = document.createElement("main");
	panel.setAttribute("role", "alert");
	panel.style.cssText =
		"box-sizing:border-box;max-width:720px;margin:12vh auto;padding:24px;font:14px/1.5 system-ui;color:inherit";
	const title = document.createElement("h1");
	title.style.cssText = "font-size:18px;margin:0 0 12px";
	title.textContent = "Ling could not connect to its host";
	const message = document.createElement("pre");
	message.style.cssText = "white-space:pre-wrap;word-break:break-word;margin:0";
	message.textContent = error.message;
	panel.append(title, message);
	root.append(panel);
}

function webSocketUrl(): string {
	const url = new URL(WEB_SOCKET_PATH, window.location.href);
	url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
	url.hash = "";
	return url.href;
}

function takeWebToken(): string {
	const fragment = window.location.hash.startsWith("#") ? window.location.hash.slice("#".length) : window.location.hash;
	const launchToken = new URLSearchParams(fragment).get(WEB_TOKEN_FRAGMENT_KEY);
	if (window.location.hash.length > 0)
		window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
	if (launchToken) window.sessionStorage.setItem(WEB_TOKEN_STORAGE_KEY, launchToken);
	const token = launchToken ?? window.sessionStorage.getItem(WEB_TOKEN_STORAGE_KEY);
	if (!token) throw new Error("The launch URL does not contain a Ling host token");
	return token;
}

function webClientId(): string {
	const existing = window.sessionStorage.getItem(WEB_CLIENT_ID_KEY);
	if (existing) return existing;
	const created = crypto.randomUUID();
	window.sessionStorage.setItem(WEB_CLIENT_ID_KEY, created);
	return created;
}

async function authenticateHostHttp(token: string): Promise<void> {
	const response = await fetch("/api/auth", {
		method: "POST",
		headers: { Authorization: `Bearer ${token}` },
		credentials: "same-origin",
	});
	if (!response.ok) throw new Error(`Ling host HTTP authentication failed (${String(response.status)})`);
}

function freezeApi(api: typeof window.ling): typeof window.ling {
	for (const value of Object.values(api)) {
		if (typeof value === "object" && value !== null) Object.freeze(value);
	}
	return Object.freeze(api);
}

async function installLingApi(signal: AbortSignal): Promise<void> {
	const nativeShell = window.lingShell;
	const connectionInfo = nativeShell
		? await nativeShell.host.connection()
		: { url: webSocketUrl(), token: takeWebToken() };
	await authenticateHostHttp(connectionInfo.token);
	const connection = await connectHostWebSocket({
		url: connectionInfo.url,
		token: connectionInfo.token,
		clientId: webClientId(),
		product: nativeShell ? "electron" : "web",
		onProtocolError: showBootstrapError,
		onReloadRequired: () => window.location.reload(),
	});
	if (signal.aborted) {
		connection.dispose();
		signal.throwIfAborted();
	}
	signal.addEventListener("abort", connection.dispose, { once: true });
	const shell =
		nativeShell ??
		createBrowserShell(
			connectionInfo,
			connection.welcome.environment,
			connection.welcome.environment.appVersion,
			signal,
			createProcedureClient(projectProcedures, connection.transport).browseDirectories,
		);
	connection.transport.subscribe<HostShellEvent>(HOST_SHELL_EVENT_CHANNEL, shell.lifecycle.handleHostEvent);
	const shellState = await connection.transport.invoke<HostShellState>(HOST_SHELL_STATE_METHOD, []);
	shell.lifecycle.handleHostEvent({ type: "keepAwakePreference", enabled: shellState.keepAwakeEnabled });
	shell.lifecycle.handleHostEvent({ type: "keepRunningPreference", enabled: shellState.keepRunningEnabled });
	for (const ref of shellState.runningRefs)
		shell.lifecycle.handleHostEvent({ type: "agentRunState", ref, running: true });
	const api = freezeApi(
		createLingApiClient({
			hostTransport: connection.transport,
			onBackgroundError: (error) => window.reportError(toError(error)),
			shell,
			env: connection.welcome.environment,
			ui: { translucent: shell.capabilities.windowTranslucency, capabilities: shell.capabilities },
			signal,
		}),
	);
	if (nativeShell) document.documentElement.dataset.lingNativePlatform = api.env.platform;
	Object.defineProperty(window, "ling", { value: api, configurable: false, enumerable: true, writable: false });
}

const lifetime = new AbortController();
window.addEventListener("pagehide", () => lifetime.abort(), { once: true });
window.addEventListener("pageshow", (event) => {
	// A restored back-forward cache entry has already released its Host connection.
	if (event.persisted) window.location.reload();
});
try {
	await installLingApi(lifetime.signal);
	const { mountApp } = await import("./main");
	mountApp(lifetime.signal);
} catch (error) {
	lifetime.abort();
	showBootstrapError(toError(error));
}
