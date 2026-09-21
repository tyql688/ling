import type { PiGlobalSettingsStore } from "./global-settings-store";
import type { PiSettingsMutations } from "./settings-mutation";
import { hasControlCharacter } from "@ling/contracts/text-validation";
import { EventEmitter } from "node:events";
import { homedir } from "node:os";
import {
	type Dispatcher,
	Agent,
	Client,
	EnvHttpProxyAgent,
	getGlobalDispatcher,
	install,
	Pool,
	setGlobalDispatcher,
} from "undici";
import { requestCancelled, throwAggregateFailures } from "../../ling-error";
import { createLogger } from "../../logger";
import { redactProxyUrl } from "../../proxy-url";
import { createSettingsManager } from "../sdk-factories";
import type { PiSettingsManager } from "../types";

const log = createLogger("http-proxy");
/** Proxy URL length limit; 4Ki far exceeds any legitimate proxy URL, anything longer is rejected as dirty input. */
const MAX_PROXY_URL_LENGTH = 4096;
/** Environment variable keys matching undici/EnvHttpProxyAgent; both cases cover common shell habits. */
const PROXY_ENV_KEYS = ["https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY"] as const;
type ProxyEnvironmentKey = (typeof PROXY_ENV_KEYS)[number];
type ProxyEnvironmentSnapshot = Record<ProxyEnvironmentKey, string | undefined>;

function ignoreUndiciDispatcherError(): void {}

/** The body stream still reports failures; this only prevents an unhandled EventEmitter error. */
function withUndiciErrorListener<T extends Dispatcher>(dispatcher: T): T {
	if (dispatcher instanceof EventEmitter) {
		EventEmitter.prototype.on.call(dispatcher, "error", ignoreUndiciDispatcherError);
	}
	return dispatcher;
}

function createUndiciClient(origin: URL, options: object): Dispatcher {
	return withUndiciErrorListener(new Client(origin, options as Client.Options));
}

function createUndiciOriginDispatcher(origin: URL, options: object): Dispatcher {
	const dispatcherOptions = options as Pool.Options;
	if (dispatcherOptions.connections === 1) return createUndiciClient(origin, dispatcherOptions);
	return withUndiciErrorListener(
		new Pool(origin, {
			...dispatcherOptions,
			factory: createUndiciClient,
		}),
	);
}

/** undici's EnvHttpProxyAgent reads lowercase first, then uppercase — mirror that here. */
function effectiveProxyEnv(): string | null {
	return process.env.https_proxy ?? process.env.HTTPS_PROXY ?? process.env.http_proxy ?? process.env.HTTP_PROXY ?? null;
}

function captureProxyEnvironment(): ProxyEnvironmentSnapshot {
	return {
		https_proxy: process.env.https_proxy,
		HTTPS_PROXY: process.env.HTTPS_PROXY,
		http_proxy: process.env.http_proxy,
		HTTP_PROXY: process.env.HTTP_PROXY,
	};
}

function restoreProxyEnvironment(snapshot: ProxyEnvironmentSnapshot): void {
	for (const key of PROXY_ENV_KEYS) {
		const value = snapshot[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

function validateProxyUrl(proxy: string): void {
	if (proxy.length > MAX_PROXY_URL_LENGTH || hasControlCharacter(proxy)) {
		throw new Error("Proxy URL is invalid or too long");
	}
	let parsed: URL;
	try {
		parsed = new URL(proxy);
	} catch {
		throw new Error("Proxy URL must use http:// or https://");
	}
	if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.hostname.length === 0) {
		throw new Error("Proxy URL must use http:// or https://");
	}
}

export function createPiHttpProxy({
	agentDir,
	globalSettingsStore,
	mutations,
}: {
	agentDir: string;
	globalSettingsStore: PiGlobalSettingsStore;
	mutations: PiSettingsMutations;
}) {
	let disposed = false;
	let disposal: Promise<void> | null = null;
	const originalDispatcher = getGlobalDispatcher();
	let currentDispatcher: Dispatcher | null = null;
	const ownedDispatchers = new Set<Dispatcher>();
	const retiringDispatchers = new Set<Promise<void>>();
	// These are exactly the globals installed by the bundled undici implementation.
	const FETCH_GLOBAL_KEYS = [
		"fetch",
		"Headers",
		"Response",
		"Request",
		"FormData",
		"WebSocket",
		"CloseEvent",
		"ErrorEvent",
		"MessageEvent",
		"EventSource",
	] as const;
	const originalGlobals = new Map(
		FETCH_GLOBAL_KEYS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
	);
	const installedGlobals = new Map<string, unknown>();
	let lastAppliedProxyEnvironment: ProxyEnvironmentSnapshot | null = null;
	const { enqueueGlobalSettingsMutation } = mutations;

	const originalGlobalFetch = globalThis.fetch;
	let installedGlobalFetch: typeof globalThis.fetch | undefined;
	let inheritedProxyEnvironment: ProxyEnvironmentSnapshot | null = null;
	let configuredProxy: string | null = null;
	let configuredHttpIdleTimeoutMs: number | null = null;
	let systemProxyFallback: string | null = null;

	/**
	 * Pi ships full proxy support (settings.json `httpProxy` → env vars → an undici
	 * EnvHttpProxyAgent global dispatcher), but wires it up only in its own CLI entrypoints
	 * (main.js/cli.js/rpc-entry.js) — none of which run when Ling embeds the SDK. This module
	 * carries that bootstrap into Ling's Pi workers with the same setting and env-var precedence.
	 * Proxy traffic uses EnvHttpProxyAgent; direct traffic stays on Agent because routing a
	 * no-proxy request through EnvHttpProxyAgent resets TLS connections on some account APIs.
	 */

	function globalSettingsManager(): PiSettingsManager {
		// Same construction as the global package manager: cwd is irrelevant for global reads.
		return createSettingsManager(homedir(), agentDir);
	}

	function configureDispatcher(timeoutMs: number): void {
		if (disposed) throw requestCancelled("The Pi network has been disposed.");
		const options = {
			allowH2: false,
			bodyTimeout: timeoutMs,
			factory: createUndiciOriginDispatcher,
			headersTimeout: timeoutMs,
			// Undici 8.7 changed HTTP proxying to absolute-form requests by default.
			// Pi providers need the same CONNECT tunnel for HTTP and HTTPS origins so a
			// streamed tool-call response can keep using its established proxy channel.
			proxyTunnel: true,
		};
		const dispatcher = effectiveProxyEnv()
			? new EnvHttpProxyAgent({ ...options, clientFactory: createUndiciClient })
			: new Agent(options);
		const previous = currentDispatcher;
		ownedDispatchers.add(dispatcher);
		currentDispatcher = dispatcher;
		setGlobalDispatcher(withUndiciErrorListener(dispatcher));
		if (previous) {
			const retirement = previous
				.close()
				.catch((error: unknown) => {
					log.error("Failed to close a retired Pi HTTP dispatcher:", error);
				})
				.finally(() => {
					ownedDispatchers.delete(previous);
					retiringDispatchers.delete(retirement);
				});
			retiringDispatchers.add(retirement);
		}
		// Keep global fetch and the dispatcher on the same undici implementation — pi's
		// http-dispatcher does this to avoid Node/npm-undici mismatches on streamed bodies.
		const shouldInstallGlobals =
			installedGlobalFetch === undefined
				? globalThis.fetch === originalGlobalFetch
				: globalThis.fetch === installedGlobalFetch;
		if (shouldInstallGlobals) {
			install();
			installedGlobalFetch = globalThis.fetch;
			for (const key of FETCH_GLOBAL_KEYS) installedGlobals.set(key, Reflect.get(globalThis, key));
		}
	}

	function ensureInheritedProxyEnvironment(): ProxyEnvironmentSnapshot {
		inheritedProxyEnvironment ??= captureProxyEnvironment();
		return inheritedProxyEnvironment;
	}

	/** Recomputes the documented order: login-shell env, Pi setting, then GUI system fallback. */
	function applyProxyLayers(): void {
		if (disposed) throw requestCancelled("The Pi network has been disposed.");
		restoreProxyEnvironment(ensureInheritedProxyEnvironment());
		if (effectiveProxyEnv() === null && configuredProxy) {
			process.env.HTTP_PROXY = configuredProxy;
			process.env.HTTPS_PROXY = configuredProxy;
		}
		if (effectiveProxyEnv() === null && systemProxyFallback) {
			process.env.HTTP_PROXY = systemProxyFallback;
			process.env.HTTPS_PROXY = systemProxyFallback;
		}
		lastAppliedProxyEnvironment = captureProxyEnvironment();
	}

	/** Rebuild the dispatcher so it re-reads the (possibly just-changed) proxy env vars. */
	function reconfigureHttpDispatcher(): void {
		const timeoutMs = globalSettingsManager().getHttpIdleTimeoutMs();
		configuredHttpIdleTimeoutMs = timeoutMs;
		configureDispatcher(timeoutMs);
	}

	/** Registers the Chromium-resolved proxy as the lowest-priority GUI-only layer. */
	function applySystemProxyFallback(proxy: string): void {
		validateProxyUrl(proxy);
		systemProxyFallback = proxy;
		applyProxyLayers();
		reconfigureHttpDispatcher();
	}

	/**
	 * Startup bootstrap: settings.json's httpProxy seeds the proxy env vars (an already-set
	 * env var wins — e.g. imported from the login shell, exactly like a terminal-run `pi`),
	 * then the matching direct or proxy dispatcher is installed globally for every SDK fetch.
	 */
	function initHttpProxy(): void {
		const settings = globalSettingsManager();
		configuredProxy = settings.getGlobalSettings().httpProxy?.trim() || null;
		configuredHttpIdleTimeoutMs = settings.getHttpIdleTimeoutMs();
		applyProxyLayers();
		configureDispatcher(configuredHttpIdleTimeoutMs);
		const effective = effectiveProxyEnv();
		log.info(
			`http dispatcher installed${effective ? ` (proxy: ${redactProxyUrl(effective)})` : " (no proxy configured)"}`,
		);
	}

	/** Refreshes a long-lived host from settings.json without rebuilding an unchanged dispatcher. */
	function refreshHttpProxyFromSettings(): void {
		const settings = globalSettingsManager();
		const nextProxy = settings.getGlobalSettings().httpProxy?.trim() || null;
		const nextTimeoutMs = settings.getHttpIdleTimeoutMs();
		if (nextProxy === configuredProxy && nextTimeoutMs === configuredHttpIdleTimeoutMs) return;
		configuredProxy = nextProxy;
		configuredHttpIdleTimeoutMs = nextTimeoutMs;
		applyProxyLayers();
		configureDispatcher(nextTimeoutMs);
	}

	function getHttpProxySetting(): string | null {
		const proxy = globalSettingsManager().getGlobalSettings().httpProxy?.trim();
		return proxy ? proxy : null;
	}

	async function updateProxySetting(proxy: string | undefined): Promise<void> {
		await globalSettingsStore.update((settings) => {
			if (proxy === undefined) delete settings.httpProxy;
			else settings.httpProxy = proxy;
		});
	}

	/**
	 * Persists `httpProxy` into Pi's global settings.json (shared with the pi CLI) and applies
	 * it immediately: env vars are set/cleared EXPLICITLY (unlike the ??= bootstrap — the user
	 * just changed their mind) and the dispatcher is rebuilt to pick the new env up.
	 */
	async function setHttpProxySetting(proxy: string | null): Promise<void> {
		const trimmed = proxy?.trim();
		if (trimmed) {
			// undici's EnvHttpProxyAgent tunnels via HTTP CONNECT — socks URLs are not supported.
			validateProxyUrl(trimmed);
		}
		await enqueueGlobalSettingsMutation(async () => {
			await updateProxySetting(trimmed || undefined);
			configuredProxy = trimmed || null;
			configuredHttpIdleTimeoutMs = globalSettingsManager().getHttpIdleTimeoutMs();
			applyProxyLayers();
			configureDispatcher(configuredHttpIdleTimeoutMs);
			const effective = effectiveProxyEnv();
			log.info(
				`${trimmed ? `proxy setting saved: ${redactProxyUrl(trimmed)}` : "proxy setting cleared"}; ${
					effective ? `active proxy: ${redactProxyUrl(effective)}` : "no active proxy"
				}`,
			);
		});
	}

	function dispose(): Promise<void> {
		if (disposal) return disposal;
		disposed = true;
		if (currentDispatcher && getGlobalDispatcher() === currentDispatcher) setGlobalDispatcher(originalDispatcher);
		currentDispatcher = null;
		for (const key of FETCH_GLOBAL_KEYS) {
			if (!installedGlobals.has(key) || Reflect.get(globalThis, key) !== installedGlobals.get(key)) continue;
			const descriptor = originalGlobals.get(key);
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
		if (inheritedProxyEnvironment && lastAppliedProxyEnvironment) {
			for (const key of PROXY_ENV_KEYS) {
				if (process.env[key] !== lastAppliedProxyEnvironment[key]) continue;
				const value = inheritedProxyEnvironment[key];
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
		disposal = (async () => {
			const results = await Promise.allSettled([...ownedDispatchers].map((dispatcher) => dispatcher.destroy()));
			await Promise.allSettled([...retiringDispatchers]);
			ownedDispatchers.clear();
			installedGlobals.clear();
			throwAggregateFailures(
				results.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
				"Failed to dispose Pi HTTP dispatchers",
			);
		})();
		return disposal;
	}
	return {
		reconfigureHttpDispatcher,
		applySystemProxyFallback,
		initHttpProxy,
		refreshHttpProxyFromSettings,
		getHttpProxySetting,
		setHttpProxySetting,
		dispose,
	};
}
