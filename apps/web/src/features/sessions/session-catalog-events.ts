import type { SessionSummary } from "@ling/contracts/session";
import { sameSessionRef, toSessionRef } from "@ling/contracts/session-ref";

/** Runtime summaries own conversational fields; catalog metadata remains owned by
 * the session catalog and must survive a live summary projection update. */
export function applySessionSummaryChanged(
	sessions: readonly SessionSummary[],
	summary: SessionSummary,
	fallbackTitle: string,
): SessionSummary[] {
	let matched = false;
	const next = sessions.map((current) => {
		if (!sameSessionRef(toSessionRef(current), toSessionRef(summary))) return current;
		matched = true;
		return {
			...summary,
			title: summary.title || fallbackTitle,
			...(current.archivedAt === undefined ? {} : { archivedAt: current.archivedAt }),
			...(current.pinnedAt === undefined ? {} : { pinnedAt: current.pinnedAt }),
			...(current.relation === undefined ? {} : { relation: current.relation }),
		};
	});
	return matched ? next : [...sessions];
}
