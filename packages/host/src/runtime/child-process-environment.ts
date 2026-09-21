import { delimiter, dirname } from "node:path";

const BLOCKED_CHILD_PROCESS_ENVIRONMENT_KEYS = new Set<string>([
	"DEBUG",
	"DYLD_INSERT_LIBRARIES",
	"LD_PRELOAD",
	"NODE_OPTIONS",
	"VSCODE_NODE_OPTIONS",
]);

/**
 * Appends the directory of the Node executable running this process to PATH. The GUI-launched
 * app inherits no version-manager shell state (fnm, nvm, volta, ...), so `node`/`npm` shims
 * we hand to children (for example npm install via Pi's package manager) cannot resolve.
 * The runtime Node always has its matching npm beside it, and appending — never prepending —
 * keeps any user-installed toolchain ahead of Ling's bundled runtime.
 */
function withRuntimeNodePathFallback(environment: Record<string, string>): Record<string, string> {
	const runtimeNodeDirectory = dirname(process.execPath);
	const pathKey = Object.keys(environment).find((key) => key.toLowerCase() === "path") ?? "PATH";
	const path = environment[pathKey];
	if (path === undefined || path.length === 0) {
		environment[pathKey] = runtimeNodeDirectory;
		return environment;
	}
	if (path.split(delimiter).includes(runtimeNodeDirectory)) return environment;
	environment[pathKey] = `${path}${delimiter}${runtimeNodeDirectory}`;
	return environment;
}

export function sanitizeChildProcessEnvironment(
	source: Readonly<NodeJS.ProcessEnv> = process.env,
	additionalBlockedKeys: readonly string[] = [],
): Record<string, string> {
	const blockedKeys = new Set(BLOCKED_CHILD_PROCESS_ENVIRONMENT_KEYS);
	for (const key of additionalBlockedKeys) blockedKeys.add(key.toUpperCase());
	const environment: Record<string, string> = {};
	for (const [key, value] of Object.entries(source)) {
		if (value !== undefined && !blockedKeys.has(key.toUpperCase())) {
			environment[key] = value;
		}
	}
	return withRuntimeNodePathFallback(environment);
}
