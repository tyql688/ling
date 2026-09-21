import { isAbsolute, join } from "node:path";

interface HostRuntimePaths {
	appRoot: string;
	builtinSkillsDir: string;
	logsDir: string;
	resourcesDir: string;
	hostEntriesDir: string;
	userDataDir: string;
	/** Ling-owned feature data outside the app data directory, shared by every Ling install on the machine. */
	dataHome: string;
	packaged: boolean;
}

let runtimePaths: Readonly<HostRuntimePaths> | null = null;

function assertAbsolutePath(value: string, label: string): void {
	if (!isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
}

export function configureHostRuntimePaths(paths: HostRuntimePaths): void {
	if (runtimePaths !== null) throw new Error("Ling host runtime paths are already configured");
	for (const [label, value] of Object.entries(paths)) {
		if (label === "packaged") continue;
		assertAbsolutePath(value as string, label);
	}
	runtimePaths = Object.freeze({ ...paths });
}

export function getHostRuntimePaths(): Readonly<HostRuntimePaths> {
	if (runtimePaths === null) throw new Error("Ling host runtime paths are not configured");
	return runtimePaths;
}

/** Directory of the host runtime's own node_modules binaries — the npm/npx shims installs must resolve. */
export function getHostPackageBinPath(): string {
	const paths = getHostRuntimePaths();
	return paths.packaged
		? join(paths.resourcesDir, "host", "node_modules", ".bin")
		: join(paths.appRoot, "node_modules", ".bin");
}
