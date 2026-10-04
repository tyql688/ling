import { sanitizeChildProcessEnvironment } from "@ling/host/runtime/child-process-environment";
import { getHostPackageBinPath } from "@ling/host/runtime/runtime-paths";
import { delimiter } from "node:path";

/** Toolchain children use createToolchainChildEnvironment, which prepends the Host .bin directory for pinned npm/npx and appends the bundled Node directory. Generic usage, terminal and PTY children use sanitizeChildProcessEnvironment, keeping the user toolchain before bundled Node. */
export function createToolchainChildEnvironment(
	source: Readonly<NodeJS.ProcessEnv> = process.env,
	additionalBlockedKeys: readonly string[] = [],
): Record<string, string> {
	const environment = sanitizeChildProcessEnvironment(source, additionalBlockedKeys);
	const packageBin = getHostPackageBinPath();
	const pathKey = Object.keys(environment).find((key) => key.toLowerCase() === "path") ?? "PATH";
	environment[pathKey] = environment[pathKey] ? `${packageBin}${delimiter}${environment[pathKey]}` : packageBin;
	return environment;
}
