import type { ProjectAccess } from "@ling/host/runtime/project-access";
import { resolve } from "node:path";
import type { PiWorkerClient } from "../../workers/pi/pi-worker-client";
import { findKnownWorkspaceRoot } from "./workspace-paths";

export function createProjectOperations(
	piWorker: Pick<PiWorkerClient, "listOpenProjectPaths" | "withProject">,
): ProjectAccess {
	/** Validates a renderer-supplied root and returns the canonical open-project path
	 * without acquiring a lifecycle lease. Use this when the core operation owns its
	 * own lease; nesting `withOpenProject()` can deadlock against a global reload barrier. */
	function resolveKnownOpenProjectPath(cwd: string): string {
		const openProjectPaths = piWorker.listOpenProjectPaths();
		const canonical = findKnownWorkspaceRoot(resolve(cwd), openProjectPaths);
		if (!canonical) throw new Error(`Unknown workspace: ${cwd}`);
		return canonical;
	}

	/** Validates a renderer-supplied workspace root, then holds its Project lifecycle
	 * slot open until the main-process operation settles. */
	function withKnownOpenProject<T>(cwd: string, operation: (canonicalCwd: string) => Promise<T>): Promise<T> {
		let canonicalCwd: string;
		try {
			canonicalCwd = resolveKnownOpenProjectPath(cwd);
		} catch (error) {
			return Promise.reject(error);
		}
		return piWorker.withProject(canonicalCwd, operation);
	}
	return { resolveKnownOpenProjectPath, withKnownOpenProject };
}
