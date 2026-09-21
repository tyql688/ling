import { pathIdentity } from "@ling/core/paths";
import { resolve } from "node:path";

export function assertKnownWorkspaceRoot(candidate: string, openWorkspaceRoots: readonly string[]): void {
	if (findKnownWorkspaceRoot(candidate, openWorkspaceRoots) === null) {
		throw new Error(`Unknown workspace: ${candidate}`);
	}
}

/** Returns the canonical root owned by main. Windows paths compare case-insensitively,
 * matching filesystem and Core project-alias identity rather than renderer spelling. */
export function findKnownWorkspaceRoot(candidate: string, openWorkspaceRoots: readonly string[]): string | null {
	const candidateIdentity = pathIdentity(resolve(candidate));
	return openWorkspaceRoots.find((root) => pathIdentity(resolve(root)) === candidateIdentity) ?? null;
}
