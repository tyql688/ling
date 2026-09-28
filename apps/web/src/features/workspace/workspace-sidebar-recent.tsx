import type { SessionSummary } from "@ling/contracts/session";
import { AnimatePresence } from "motion/react";
import type { ReactElement } from "react";

const RECENT_SESSION_LIMIT = 10;

export function WorkspaceSidebarSessionSection({
	label,
	sessions,
	renderSession,
}: {
	label: string;
	sessions: readonly SessionSummary[];
	renderSession: (session: SessionSummary) => ReactElement;
}) {
	return (
		<section aria-label={label}>
			<div className="px-3 pt-1.5 pb-1 text-xs font-medium text-text-muted">{label}</div>
			{/* Rows are motion.divs (see workspace-sidebar renderSession): new sessions slide in,
			    archived/deleted ones collapse out, and pin/activity reorders glide via layout. */}
			<div className="flex flex-col gap-px">
				<AnimatePresence initial={false}>{sessions.map(renderSession)}</AnimatePresence>
			</div>
		</section>
	);
}

/** The most recently active sessions as one flat list; pinned sessions keep their recency position. */
export function WorkspaceSidebarRecent({
	sessions,
	renderSession,
}: {
	sessions: readonly SessionSummary[];
	renderSession: (session: SessionSummary) => ReactElement;
}) {
	const recent = [...sessions]
		.sort(
			(left, right) =>
				right.updatedAt - left.updatedAt || right.createdAt - left.createdAt || left.id.localeCompare(right.id),
		)
		.slice(0, RECENT_SESSION_LIMIT);
	return (
		<div className="flex flex-col gap-px">
			<AnimatePresence initial={false}>{recent.map(renderSession)}</AnimatePresence>
		</div>
	);
}
