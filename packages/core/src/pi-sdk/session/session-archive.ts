import type { SessionMessage } from "@ling/contracts/session";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createLingError } from "../../ling-error";
import { projectPiBranchMessages } from "./session-message-projector";

/**
 * Reads a persisted session without a runtime. Pi refuses to resume a session whose stored working
 * directory is gone, so a deleted project would otherwise take its history with it. Opening the file
 * directly keeps that history readable; nothing here binds a runtime, so the session cannot continue.
 */
export function readArchivedPiSessionMessages(sessionFilePath: string, markdownWidth: number): SessionMessage[] {
	let sessionManager: ReturnType<typeof SessionManager.open>;
	try {
		sessionManager = SessionManager.open(sessionFilePath);
	} catch (error) {
		throw createLingError(
			{
				code: "SESSION_NOT_FOUND",
				category: "external",
				message: `The session file could not be read: ${sessionFilePath}`,
				retryable: false,
				details: { sessionFilePath },
			},
			error,
		);
	}
	// No project is loaded for an archived read, so no extension renders its entries, and nothing
	// could later fetch a deferred tool body — the projection keeps tool output inline.
	return projectPiBranchMessages({ sessionManager, extensions: null }, { markdownWidth, deferToolResults: false });
}
