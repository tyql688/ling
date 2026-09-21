import { sanitizeChildProcessEnvironment } from "@ling/host/runtime/child-process-environment";
import { getHostPackageBinPath } from "@ling/host/runtime/runtime-paths";
import { delimiter } from "node:path";

/**
 * One environment policy for every process Ling spawns, in two tiers:
 *
 * - Toolchain children (package installs, skills updates, Pi worker) run through
 *   `createToolchainChildEnvironment`, which prepends the host runtime's own `.bin` so a
 *   packaged build resolves npm/npx to Ling's pinned copies — never the user's toolchain —
 *   while `sanitizeChildProcessEnvironment` appends the runtime node they require.
 * - Generic children (usage host, terminal host, pty shells) use plain
 *   `sanitizeChildProcessEnvironment`: the user's own toolchain wins and the runtime node
 *   is only a last-resort fallback.
 */
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
