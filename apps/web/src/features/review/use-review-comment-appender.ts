import {
	appendReviewComment,
	type ReviewCommentDraft,
	type ReviewCommentIssue,
} from "@ling/contracts/draft-review-comments";
import { sessionKey, type SessionRef } from "@ling/contracts/session-ref";
import { draftsAtom, EMPTY_DRAFT } from "@renderer/features/sessions/state/drafts";
import { useSetAtom } from "jotai";
import { useCallback } from "react";

/** Adds a line comment to the owning session's composer draft. */
export function useReviewCommentAppender(
	sessionRef: SessionRef,
): (comment: Omit<ReviewCommentDraft, "id">) => ReviewCommentIssue | null {
	const setDrafts = useSetAtom(draftsAtom);
	return useCallback(
		(comment: Omit<ReviewCommentDraft, "id">): ReviewCommentIssue | null => {
			const key = sessionKey(sessionRef);
			let issue: ReviewCommentIssue | null = "size";
			const candidate = { ...comment, id: crypto.randomUUID() };
			setDrafts((previous) => {
				const current = previous[key] ?? EMPTY_DRAFT;
				const result = appendReviewComment(current.reviewComments, candidate);
				issue = result.issue;
				if (result.issue !== null) return previous;
				return {
					...previous,
					[key]: { ...current, reviewComments: result.comments },
				};
			});
			return issue;
		},
		[sessionRef, setDrafts],
	);
}
