import type { SessionRef, SessionRelation } from "@ling/contracts/session";
import { toSessionRef } from "@ling/contracts/session-ref";
import { pathIdentity } from "@ling/core/paths";

interface RelatableSessionSummary {
	id: string;
	cwd: string;
	title: string;
	sessionFilePath: string;
	parentSessionFilePath?: string;
	manualFork?: boolean;
}

/** Session-file map keys share project pathIdentity (win32 fold, posix preserve). */
function normalizeSessionPath(filePath: string): string {
	return pathIdentity(filePath);
}

function hasSubagentSessionPath(filePath: string): boolean {
	const path = normalizeSessionPath(filePath);
	const normalized = process.platform === "win32" ? path.replaceAll("\\", "/") : path;
	return normalized.includes("/sessions/subagents/") || normalized.includes("/sessions-subagents/");
}

function parentRefFor(
	parentSessionFilePath: string,
	bySessionFilePath: ReadonlyMap<string, SessionRef>,
): SessionRef | null {
	return bySessionFilePath.get(normalizeSessionPath(parentSessionFilePath)) ?? null;
}

function classifySession(
	session: RelatableSessionSummary,
	bySessionFilePath: ReadonlyMap<string, SessionRef>,
): SessionRelation | null {
	if (!session.parentSessionFilePath) return null;
	const parentRef = parentRefFor(session.parentSessionFilePath, bySessionFilePath);
	if (!parentRef) return null;

	if (session.manualFork === true) {
		return {
			kind: "manualFork",
			parentRef,
			parentSessionFilePath: session.parentSessionFilePath,
		};
	}

	const strongPath = hasSubagentSessionPath(session.sessionFilePath);
	return {
		kind: "child",
		parentRef,
		parentSessionFilePath: session.parentSessionFilePath,
		source: "subagent",
		confidence: strongPath ? "strong" : "medium",
		reason: strongPath ? "subagent-session-dir" : "forked-plugin-session",
	};
}

export function attachSessionRelations<T extends RelatableSessionSummary>(
	sessions: readonly T[],
): Array<T & { relation?: SessionRelation }> {
	const bySessionFilePath = new Map<string, SessionRef>();
	for (const session of sessions) {
		if (!session.sessionFilePath) continue;
		bySessionFilePath.set(normalizeSessionPath(session.sessionFilePath), toSessionRef(session));
	}

	return sessions.map((session) => {
		const relation = classifySession(session, bySessionFilePath);
		if (!relation) return session;
		return { ...session, relation };
	});
}
