import type { AppPlatform } from "@ling/contracts/application";
import { HOST_STDIO_MESSAGE_PREFIX, type HostShellEvent, type HostSupervisorMessage } from "@ling/contracts/host-shell";
import { createLogger, parseStructuredLogLine, writeLogRecord } from "@ling/core/logger";
import { toError } from "@ling/core/ling-error";
import { mkdir, readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHostBusinessRuntime } from "./app/business-runtime";
import { createRuntimeLifetime } from "@ling/node-runtime/runtime-lifetime";
import { loadPreferredHostPort, savePreferredHostPort } from "./runtime/host-port-state";
import { createDiagnosticsStore, type DiagnosticsStore } from "./runtime/diagnostics-store";
import { configureHostRuntimePaths } from "./runtime/runtime-paths";
import { createHostEventBus } from "./transport/event-bus";
import { createHostRequestRouter } from "./transport/request-router";
import { startHostWebServer } from "./transport/web-server";

declare const __LING_VERSION__: string;

const log = createLogger("host");

const stdioSupervisor = process.env.LING_HOST_STDIO_CONTROL === "1";
/** Leave time for owned worker drains, while bounding an unexpected process failure. */
const FATAL_EXIT_TIMEOUT_MS = 20_000;
const lifetime = createRuntimeLifetime(["transport", "runtime"] as const);
const events = createHostEventBus();
const router = createHostRequestRouter();
let runtimeStartup: ReturnType<typeof createHostBusinessRuntime> | null = null;
let serverStartup: ReturnType<typeof startHostWebServer> | null = null;
let runtime: Awaited<ReturnType<typeof createHostBusinessRuntime>> | null = null;
let startupComplete = false;
let shuttingDown = false;
let exitCode = 0;
let fatalTimer: ReturnType<typeof setTimeout> | null = null;
let diagnostics: DiagnosticsStore | null = null;

lifetime.onStop("request admission", router.stop);
lifetime.onStop("business admission", () => runtime?.prepareShutdown());
// Register pending acquisitions before starting them, so fatal errors during startup
// still own resources whose constructors have not returned yet.
lifetime.defer("transport", "HTTP and WebSocket server", async () => (await serverStartup)?.close());
lifetime.defer("runtime", "business runtime", async () => (await runtimeStartup)?.dispose());

function shutdown(error?: unknown): void {
	if (error !== undefined) {
		exitCode = 1;
		log.error(`Ling host ${startupComplete ? "runtime" : "startup"} failed:`, toError(error));
		fatalTimer ??= setTimeout(() => {
			log.error("Ling host fatal exit deadline reached");
			process.exit(1);
		}, FATAL_EXIT_TIMEOUT_MS);
	}
	if (shuttingDown) return;
	shuttingDown = true;
	void lifetime.dispose().then(
		() => process.exit(exitCode),
		(cleanupError: unknown) => {
			log.error("Ling host shutdown failed:", cleanupError);
			process.exit(1);
		},
	);
}

function sendSupervisorMessage(message: HostSupervisorMessage): void {
	if (stdioSupervisor) {
		process.stdout.write(`${HOST_STDIO_MESSAGE_PREFIX}${JSON.stringify(message)}\n`);
		return;
	}
	process.send?.(message);
}

interface HostCliOptions {
	appRoot: string;
	resourcesDir: string;
	staticDirectory: string;
	userDataDir: string;
	packaged: boolean;
	systemProxyFallback: string | null;
}

function optionValue(argv: readonly string[], name: string): string | undefined {
	return argv.find((argument) => argument.startsWith(`${name}=`))?.slice(name.length + 1);
}

function absoluteOption(argv: readonly string[], name: string, fallback: string): string {
	const value = optionValue(argv, name) ?? fallback;
	return isAbsolute(value) ? value : resolve(value);
}

function parseOptions(argv = process.argv.slice(2)): HostCliOptions {
	const entryDirectory = dirname(fileURLToPath(import.meta.url));
	const appRoot = absoluteOption(argv, "--app-root", process.cwd());
	const userDataDir = absoluteOption(
		argv,
		"--user-data-dir",
		process.env.LING_USER_DATA_DIR ?? join(homedir(), ".ling"),
	);
	return {
		appRoot,
		resourcesDir: absoluteOption(argv, "--resources-dir", appRoot),
		staticDirectory: absoluteOption(argv, "--static-dir", resolve(entryDirectory, "../web")),
		userDataDir,
		packaged: argv.includes("--packaged"),
		systemProxyFallback: optionValue(argv, "--system-proxy-fallback") ?? null,
	};
}

function appPlatform(): AppPlatform {
	return process.platform === "darwin" || process.platform === "win32" || process.platform === "linux"
		? process.platform
		: "other";
}

async function assertStaticBuild(staticDirectory: string): Promise<void> {
	await readFile(join(staticDirectory, "index.html"));
}

async function main(): Promise<void> {
	const options = parseOptions();
	await Promise.all([mkdir(options.userDataDir, { recursive: true }), assertStaticBuild(options.staticDirectory)]);
	if (shuttingDown) return;
	configureHostRuntimePaths({
		appRoot: options.appRoot,
		builtinSkillsDir: options.packaged
			? join(options.resourcesDir, "builtin-skills")
			: join(options.appRoot, "builtin-skills"),
		logsDir: join(options.userDataDir, "logs"),
		hostEntriesDir: dirname(fileURLToPath(import.meta.url)),
		resourcesDir: options.resourcesDir,
		userDataDir: options.userDataDir,
		dataHome: absoluteOption(process.argv.slice(2), "--data-home", process.env.LING_HOME ?? join(homedir(), ".ling")),
		packaged: options.packaged,
	});
	try {
		diagnostics = createDiagnosticsStore(join(options.userDataDir, "logs"));
	} catch (error) {
		log.warn("diagnostics store is unavailable; logging to the console only:", error);
	}
	const preferredPort = await loadPreferredHostPort(options.userDataDir);
	if (shuttingDown) return;
	runtimeStartup = createHostBusinessRuntime({
		router,
		events,
		diagnostics,
		appVersion: __LING_VERSION__,
		systemProxyFallback: options.systemProxyFallback,
		onShellEvent: (event: HostShellEvent) => {
			sendSupervisorMessage({ type: "ling-host-shell-event", event });
		},
	});
	runtime = await runtimeStartup;
	if (shuttingDown) return;
	serverStartup = startHostWebServer({
		environment: { appVersion: __LING_VERSION__, home: homedir(), platform: appPlatform() },
		events,
		preferredPort,
		router,
		staticDirectory: options.staticDirectory,
		serveMedia: runtime.serveMedia,
		onClientDisconnected: runtime.disconnectClient,
	});
	const server = await serverStartup;
	if (shuttingDown) return;
	await savePreferredHostPort(options.userDataDir, Number(new URL(server.origin).port));
	if (shuttingDown) return;
	startupComplete = true;

	sendSupervisorMessage({
		type: "ling-host-ready",
		hostId: server.hostId,
		origin: server.origin,
		token: server.token,
	});
	if (!process.send && !stdioSupervisor) process.stdout.write(`${server.launchUrl}\n`);
}

process.on("uncaughtException", (error) => shutdown(toError(error)));
process.on("unhandledRejection", (error) => shutdown(toError(error)));
process.on("SIGINT", () => shutdown());
process.on("SIGTERM", () => shutdown());
process.on("disconnect", () => shutdown());
if (stdioSupervisor) {
	// The Desktop shell forwards its own log lines here; stdin EOF means the shell is gone.
	const input = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
	input.on("line", (line) => {
		const record = parseStructuredLogLine(line);
		if (record) writeLogRecord(record);
	});
	input.once("close", () => shutdown());
}
void main().catch((error: unknown) => shutdown(toError(error)));
