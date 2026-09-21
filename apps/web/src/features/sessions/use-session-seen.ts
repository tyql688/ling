import type { SessionSummary } from "@ling/contracts/session";
import { sessionKey, toSessionRef } from "@ling/contracts/session-ref";
import { useSetAtom } from "jotai";
import { useEffect } from "react";
import { sessionSeenAtAtom } from "./state/seen";

/** Seed historical sessions without unread badges, then follow the session the user is viewing. */
export function useSessionSeen(sessions: readonly SessionSummary[], activeSession: SessionSummary | undefined): void {
	const setSessionSeenAt = useSetAtom(sessionSeenAtAtom);
	useEffect(() => {
		if (sessions.length === 0) return;
		setSessionSeenAt((current) => {
			let changed = false;
			const next = { ...current };
			for (const session of sessions) {
				const key = sessionKey(toSessionRef(session));
				if (next[key] !== undefined) continue;
				next[key] = session.updatedAt;
				changed = true;
			}
			return changed ? next : current;
		});
	}, [sessions, setSessionSeenAt]);

	useEffect(() => {
		if (!activeSession) return;
		const key = sessionKey(toSessionRef(activeSession));
		setSessionSeenAt((current) =>
			current[key] === activeSession.updatedAt ? current : { ...current, [key]: activeSession.updatedAt },
		);
	}, [activeSession, setSessionSeenAt]);
}
