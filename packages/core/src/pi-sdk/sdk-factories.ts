import {
	CONFIG_DIR_NAME,
	createAgentSession,
	createExtensionRuntime,
	DefaultPackageManager,
	getAgentDir,
	hasTrustRequiringProjectResources,
	ProjectTrustStore,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type {
	PiCreateAgentSessionOptions,
	PiExtensionRuntime,
	PiProgressEvent,
	PiSessionManager,
	PiSettingsManager,
} from "./types";

export function createProjectTrustStore(agentDir = getAgentDir()): ProjectTrustStore {
	return new ProjectTrustStore(agentDir);
}

export function hasPiTrustRequiringProjectResources(cwd: string): boolean {
	return hasTrustRequiringProjectResources(cwd);
}

export function createSettingsManager(
	cwd = homedir(),
	agentDir = getAgentDir(),
	options?: Parameters<typeof SettingsManager.create>[2],
): PiSettingsManager {
	return SettingsManager.create(cwd, agentDir, options);
}

export function createInMemorySettingsManager(
	settings: Parameters<typeof SettingsManager.inMemory>[0],
): PiSettingsManager {
	return SettingsManager.inMemory(settings);
}

export function createPiExtensionRuntime(): PiExtensionRuntime {
	return createExtensionRuntime();
}

export async function createPiAgentSession(options: PiCreateAgentSessionOptions) {
	return createAgentSession(options);
}

export function createInMemoryPiSessionManager(cwd?: string): PiSessionManager {
	return SessionManager.inMemory(cwd);
}

export function createPiPackageManagerHandle(
	cwd: string,
	onProgress: (event: PiProgressEvent) => void,
	options?: Parameters<typeof SettingsManager.create>[2],
): {
	packageManager: DefaultPackageManager;
	settingsManager: PiSettingsManager;
	packageSourceBaseDirs: { global: string; project: string };
} {
	const agentDir = getAgentDir();
	const projectCwd = resolve(cwd);
	const settingsManager = createSettingsManager(cwd, agentDir, options);
	const packageManager = new DefaultPackageManager({
		cwd: projectCwd,
		agentDir,
		settingsManager,
	});
	packageManager.setProgressCallback(onProgress);
	return {
		packageManager,
		settingsManager,
		packageSourceBaseDirs: { global: agentDir, project: join(projectCwd, CONFIG_DIR_NAME) },
	};
}
