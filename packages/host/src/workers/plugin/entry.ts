import { configureLoggerOutput, createLogger } from "@ling/core/logger";
import { createPiPluginHost } from "@ling/core/pi-sdk/entrypoints/plugin-host";
import {
	PLUGIN_HOST_SYSTEM_PROXY_FALLBACK_ENV,
	PLUGIN_HOST_RESPONSE_MAX_BYTES,
	parsePluginHostRequest,
	parsePluginHostResponse,
	type PluginHostEvent,
	type PluginHostResponse,
} from "@ling/core/plugin-host/protocol";
import { createWorkerRpc, postWorkerMessage } from "../worker-rpc";

/**
 * Entry point of the plugin host — a separate Node child forked by the Ling host.
 * Runs the SDK's package manager where its synchronous npm spawns and long
 * scans can't block the main process (and with it every live session).
 */

configureLoggerOutput({ process: "plugin-host", structured: true });
const log = createLogger("plugin-host");
const configuredSystemProxyFallback = process.env[PLUGIN_HOST_SYSTEM_PROXY_FALLBACK_ENV];
delete process.env[PLUGIN_HOST_SYSTEM_PROXY_FALLBACK_ENV];
const pluginHost = createPiPluginHost(configuredSystemProxyFallback ?? null);

if (!process.send) throw new Error("plugin-host-entry requires a Node IPC channel");

// Same policy as pi-worker-entry: a stray rejection from npm/SDK package code must not kill
// the host mid-request; the client's request timeouts bound anything left hanging.
process.on("uncaughtException", (error) => log.error("uncaught exception, host kept alive:", error));
process.on("unhandledRejection", (error) => log.error("unhandled rejection, host kept alive:", error));

const rpc = createWorkerRpc<never, PluginHostResponse, PluginHostEvent>({
	// The package worker responds to commands and emits progress only.
	capacity: 0,
	capacityError: () => new Error("Package worker cannot initiate requests"),
	maxFrameBytes: PLUGIN_HOST_RESPONSE_MAX_BYTES,
	post: (value) => postWorkerMessage(process, value),
	onMessage(listener) {
		process.on("message", listener);
		return () => {
			process.off("message", listener);
		};
	},
	receiveRequest(payload, id) {
		const request = parsePluginHostRequest(payload);
		return pluginHost.handlePluginHostRequest(request, (event) => {
			void rpc
				.emit({ kind: "progress", id, event })
				.catch((error: unknown) => log.error("package progress delivery failed:", error));
		});
	},
	receiveEvent() {
		throw new Error("Package worker does not accept events");
	},
	parseResponse: parsePluginHostResponse,
	onError: (error) => log.error("package RPC failed:", error),
});

let shutdown: Promise<void> | null = null;
function stop(): void {
	shutdown ??= pluginHost.dispose().then(
		() => {
			rpc.close(new Error("Package worker stopped"));
			process.exit(0);
		},
		(error: unknown) => {
			log.error("Failed to dispose the plugin host:", error);
			process.exit(1);
		},
	);
	void shutdown;
}
process.once("disconnect", stop);
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
