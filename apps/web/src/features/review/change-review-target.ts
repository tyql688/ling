import type { ChangeReviewFile, ChangeReviewSnapshot } from "@ling/contracts/git";
import type { SessionRef } from "@ling/contracts/session-ref";
import { sessionKey } from "@ling/contracts/session-ref";

export type ChangeReviewWorkspaceScope = "turn" | "session" | "workspace" | "unpushed";

export interface ChangeReviewTarget {
	scope: ChangeReviewWorkspaceScope;
	/** Historical turn id for a turn target; null addresses the live/latest turn. */
	turnId: string | null;
	path: string;
}

const EMPTY_FILES: readonly ChangeReviewFile[] = [];

/** Resolves one workbench target against the current authoritative review snapshot. */
export function filesForChangeReviewTarget(
	snapshot: ChangeReviewSnapshot | null,
	target: Pick<ChangeReviewTarget, "scope" | "turnId">,
): readonly ChangeReviewFile[] {
	if (snapshot === null) return EMPTY_FILES;
	if (target.scope === "turn" && target.turnId !== null) {
		return snapshot.turns.find((turn) => turn.id === target.turnId)?.summary.files ?? EMPTY_FILES;
	}
	return snapshot.scopes[target.scope].files;
}

/** Stable tab identity: a path in another session, scope, or historical turn is a different review resource. */
export function changeReviewTargetKey(ref: SessionRef, target: ChangeReviewTarget): string {
	return ["review", sessionKey(ref), target.scope, target.turnId ?? "", target.path].join("\u0000");
}
