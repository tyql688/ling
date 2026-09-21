import type { SessionSummary } from "@ling/contracts/session";
import { AnimatePresence } from "motion/react";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";

type RecentGroupKey = "today" | "yesterday" | "earlier";

const RECENT_SESSION_LIMIT = 10;

interface RecentGroup {
	key: RecentGroupKey;
	sessions: SessionSummary[];
}

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
			<div className="pb-1 text-xs font-medium tracking-wide text-text-primary/65">{label}</div>
			{/* Rows are motion.divs (see workspace-sidebar renderSession): new sessions slide in,
			    archived/deleted ones collapse out, and pin/activity reorders glide via layout. */}
			<div className="flex flex-col gap-px">
				<AnimatePresence initial={false}>{sessions.map(renderSession)}</AnimatePresence>
			</div>
		</section>
	);
}

function localDayStart(now: Date, dayOffset = 0): number {
	const start = new Date(now);
	start.setHours(0, 0, 0, 0);
	start.setDate(start.getDate() + dayOffset);
	return start.getTime();
}

function groupRecentSessions(sessions: readonly SessionSummary[], now = new Date()): RecentGroup[] {
	const todayStart = localDayStart(now);
	const yesterdayStart = localDayStart(now, -1);
	const grouped: Record<RecentGroupKey, SessionSummary[]> = {
		today: [],
		yesterday: [],
		earlier: [],
	};
	const ordered = [...sessions]
		.sort(
			(left, right) =>
				right.updatedAt - left.updatedAt || right.createdAt - left.createdAt || left.id.localeCompare(right.id),
		)
		.slice(0, RECENT_SESSION_LIMIT);
	for (const session of ordered) {
		const key =
			session.updatedAt >= todayStart ? "today" : session.updatedAt >= yesterdayStart ? "yesterday" : "earlier";
		grouped[key].push(session);
	}
	return (["today", "yesterday", "earlier"] as const)
		.map((key) => ({ key, sessions: grouped[key] }))
		.filter((group) => group.sessions.length > 0);
}

export function WorkspaceSidebarRecent({
	sessions,
	renderSession,
}: {
	sessions: readonly SessionSummary[];
	renderSession: (session: SessionSummary) => ReactElement;
}) {
	const { t } = useTranslation();
	const groups = groupRecentSessions(sessions);
	return (
		<div className="flex flex-col gap-3">
			{groups.map((group) => (
				<WorkspaceSidebarSessionSection
					key={group.key}
					label={t(`sidebar.${group.key}`)}
					sessions={group.sessions}
					renderSession={renderSession}
				/>
			))}
		</div>
	);
}
