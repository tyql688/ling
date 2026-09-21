import type { SessionSummary } from "@ling/contracts/session";
import { type SessionRef, sessionKey, toSessionRef } from "@ling/contracts/session-ref";
import { sessionSeenAtFamily } from "@renderer/features/sessions/state/seen";
import {
	pendingApprovalQueueAtom,
	pendingExtensionUiQueueAtom,
	sessionBusyFamily,
	sessionErrorFamily,
	sessionQueueFamily,
} from "@renderer/features/sessions/state/session";
import { atom, useAtomValue } from "jotai";
import { useMemo } from "react";

export type WorkspaceSessionStatus = "approval" | "input" | "working" | "failed" | "done" | "ready";

export interface WorkspaceSessionStatusEntry {
	status: WorkspaceSessionStatus;
	queuedCount: number;
}

/** i18n key for a status label; null for the quiet "ready" state. Shared by the sidebar row glyph and the status bar. */
export function sessionStatusLabelKey(status: WorkspaceSessionStatus): string | null {
	switch (status) {
		case "approval":
			return "sidebar.statusApproval";
		case "input":
			return "sidebar.statusInput";
		case "working":
			return "sidebar.statusWorking";
		case "failed":
			return "sidebar.statusFailed";
		case "done":
			return "sidebar.statusDone";
		case "ready":
			return null;
	}
}

export function isActivityStatus(status: WorkspaceSessionStatus): status is "approval" | "input" | "working" {
	return status === "approval" || status === "input" || status === "working";
}

export function requireWorkspaceSessionStatus(
	statuses: ReadonlyMap<string, WorkspaceSessionStatusEntry>,
	session: SessionSummary,
): WorkspaceSessionStatusEntry {
	const key = sessionKey(toSessionRef(session));
	const entry = statuses.get(key);
	if (!entry) throw new Error(`Missing workspace status for session ${key}`);
	return entry;
}

/**
 * One derived atom subscribes only to the state required by the visible session set.
 * Busy/queue track every session that has stayed wired this run (see useSessionStatuses);
 * approval/input queues and inactive-session error/unread still surface across projects.
 */
export function useWorkspaceSessionStatuses(
	sessions: readonly SessionSummary[],
	activeSessionRef: SessionRef | null,
): ReadonlyMap<string, WorkspaceSessionStatusEntry> {
	const activeSessionKey = activeSessionRef === null ? null : sessionKey(activeSessionRef);
	const statusesAtom = useMemo(
		() =>
			atom((get) => {
				const approvalKeys = new Set(get(pendingApprovalQueueAtom).map((request) => sessionKey(request.ref)));
				const inputKeys = new Set(get(pendingExtensionUiQueueAtom).map((request) => sessionKey(request.ref)));
				const statuses = new Map<string, WorkspaceSessionStatusEntry>();

				for (const session of sessions) {
					const ref = toSessionRef(session);
					const key = sessionKey(ref);
					const isActive = activeSessionKey === key;
					const hasPendingApproval = approvalKeys.has(key);
					const hasPendingInput = inputKeys.has(key);
					const isBusy = get(sessionBusyFamily(key));
					const hasError = get(sessionErrorFamily(key));
					const seenAt = isActive ? undefined : get(sessionSeenAtFamily(key));
					// Missing means this project/session was just discovered; WorkspaceShell seeds its baseline.
					const unread = !isActive && seenAt !== undefined && session.updatedAt > seenAt;
					const status: WorkspaceSessionStatus = hasPendingApproval
						? "approval"
						: hasPendingInput
							? "input"
							: isBusy
								? "working"
								: hasError
									? "failed"
									: unread
										? "done"
										: "ready";
					const queue = get(sessionQueueFamily(key));
					statuses.set(key, {
						status,
						queuedCount: queue.steering.length + queue.followUp.length,
					});
				}

				return statuses;
			}),
		[activeSessionKey, sessions],
	);
	return useAtomValue(statusesAtom);
}
