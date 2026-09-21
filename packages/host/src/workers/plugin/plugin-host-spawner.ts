import { postWorkerMessage } from "../worker-rpc";
import { spawnHostWorkerProcess } from "../host-worker-process";
import { createLogger } from "@ling/core/logger";
import { PLUGIN_HOST_SYSTEM_PROXY_FALLBACK_ENV, type PluginHostSpawner } from "@ling/core/plugin-host/protocol";
import { createToolchainChildEnvironment } from "@ling/host/runtime/host-child-environment";
import { getHostRuntimePaths } from "@ling/host/runtime/runtime-paths";
import { join } from "node:path";

const log = createLogger("plugin-host-spawner");
const PLUGIN_HOST_CONTROLLED_ENVIRONMENT_KEYS = [
	PLUGIN_HOST_SYSTEM_PROXY_FALLBACK_ENV,
	"LING_PACKAGE_NODE_EXECUTABLE",
	"LING_PACKAGE_NPM_CLI",
	"LING_PACKAGE_NPX_CLI",
] as const;
/** Lazily forks the plugin host from the product-neutral Ling Host runtime. */
interface PluginHostSpawnerOptions {
	hostEnvironment(): Record<string, string>;
	systemProxyFallback(): string | null;
}

export function createPluginHostSpawner(options: PluginHostSpawnerOptions): PluginHostSpawner {
	return () => {
		const paths = getHostRuntimePaths();
		const environment = createToolchainChildEnvironment(
			options.hostEnvironment(),
			PLUGIN_HOST_CONTROLLED_ENVIRONMENT_KEYS,
		);
		if (paths.packaged) {
			const npmBin = join(paths.resourcesDir, "host", "node_modules", "npm", "bin");
			environment.LING_PACKAGE_NODE_EXECUTABLE = process.execPath;
			environment.LING_PACKAGE_NPM_CLI = join(npmBin, "npm-cli.js");
			environment.LING_PACKAGE_NPX_CLI = join(npmBin, "npx-cli.js");
		}
		const systemProxyFallback = options.systemProxyFallback();
		if (systemProxyFallback !== null) {
			environment[PLUGIN_HOST_SYSTEM_PROXY_FALLBACK_ENV] = systemProxyFallback;
		}
		const worker = spawnHostWorkerProcess({ entry: "plugin-host-entry.js", label: "plugin-host", env: environment });
		const { child } = worker;
		child.on("error", (error) => {
			log.error("plugin host process error:", error);
		});
		return {
			postMessage: (message) => postWorkerMessage(child, message),
			onMessage: (listener) => {
				child.on("message", listener);
				return () => {
					child.off("message", listener);
				};
			},
			onExit: (listener) => {
				child.on("exit", (code) => listener(code ?? undefined));
			},
			kill: () => worker.terminate(),
		};
	};
}
