import type { SessionRef } from "@ling/contracts/session-ref";
import type { ReactNode } from "react";
import { ReviewWorkspaceContext, ReviewWorkspaceRefreshContext, useReviewWorkspaceOwner } from "./use-review-workspace";
/** One active-workspace reader feeds the navigator, detail, timeline and change count. */
export function ReviewWorkspace({
	sessionRef,
	cwd,
	children,
}: {
	sessionRef: SessionRef | null;
	cwd: string | null;
	children: ReactNode;
}) {
	const value = useReviewWorkspaceOwner(sessionRef, cwd);
	return (
		<ReviewWorkspaceRefreshContext.Provider value={value.refresh}>
			<ReviewWorkspaceContext.Provider value={value}>{children}</ReviewWorkspaceContext.Provider>
		</ReviewWorkspaceRefreshContext.Provider>
	);
}
