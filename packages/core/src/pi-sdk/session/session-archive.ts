import type { SessionMessage } from "@ling/contracts/session-messages";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createLingError } from "../../ling-error";
import { projectPiBranchMessages } from "./session-message-projector";

/** Reads saved history for a session whose working directory is gone. Pi requires the directory to resume execution; archived reads load the file for display. */
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
	// Archived reads load complete tool output inline because deferred bodies require a runtime.

	return projectPiBranchMessages({ sessionManager, extensions: null }, { markdownWidth, deferToolResults: false });
}
