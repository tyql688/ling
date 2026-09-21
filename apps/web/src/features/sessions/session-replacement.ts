import type { SessionSummary } from "@ling/contracts/session";
import type { SessionRef } from "@ling/contracts/session-ref";
import { sameSessionRef, toSessionRef } from "@ling/contracts/session-ref";

interface SessionReplacementProjection {
	previousRef: SessionRef;
	nextRef: SessionRef;
}

export function projectReplacementSessions(
	sessions: readonly SessionSummary[],
	replacement: SessionReplacementProjection,
	provisionalTitle: string,
	now: number,
): SessionSummary[] {
	if (sessions.some((session) => sameSessionRef(toSessionRef(session), replacement.nextRef))) {
		return [...sessions];
	}

	return [
		{
			id: replacement.nextRef.sessionId,
			cwd: replacement.nextRef.cwd,
			title: provisionalTitle,
			createdAt: now,
			updatedAt: now,
			messageCount: 0,
			preview: "",
		},
		...sessions,
	];
}

export function projectReplacementActiveRef(
	activeRef: SessionRef | null,
	replacement: SessionReplacementProjection,
): SessionRef | null {
	return sameSessionRef(activeRef, replacement.previousRef) ? replacement.nextRef : activeRef;
}
