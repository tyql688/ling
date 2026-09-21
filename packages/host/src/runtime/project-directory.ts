import { createLingError, type LingError } from "@ling/core/ling-error";
import { existsSync } from "node:fs";

/**
 * A project whose folder was deleted stays open and listed so its sessions remain readable. Every
 * operation that needs the folder reports it as missing instead of surfacing a raw filesystem or
 * tool error the renderer can only show as an internal failure.
 */
export function projectDirectoryMissing(cwd: string, cause?: unknown): LingError {
	return createLingError(
		{
			code: "PROJECT_DIRECTORY_MISSING",
			category: "external",
			message: `The project directory no longer exists: ${cwd}`,
			retryable: false,
			details: { cwd },
		},
		cause,
	);
}

/** Synchronous gate for callers that cannot await, such as constructing a Git client. */
export function assertProjectDirectory(cwd: string): void {
	if (!existsSync(cwd)) throw projectDirectoryMissing(cwd);
}
