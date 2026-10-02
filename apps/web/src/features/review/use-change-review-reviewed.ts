import type { ChangeReviewFile } from "@ling/contracts/git";
import type { SessionRef } from "@ling/contracts/session-ref";
import { sessionKey } from "@ling/contracts/session-ref";
import { useAtom } from "jotai";
import { reviewedStateAtomFamily } from "./change-review-reviewed";
import type { ReviewedMap } from "@ling/contracts/user-state";

interface ChangeReviewReviewedController {
	reviewedMap: ReviewedMap;
	toggleFileReviewed: (file: ChangeReviewFile) => void;
}

/** Shared reviewed progress for every review surface mounted for one session. */
export function useChangeReviewReviewed(sessionRef: SessionRef): ChangeReviewReviewedController {
	const [reviewedMap, toggleFileReviewed] = useAtom(reviewedStateAtomFamily(sessionKey(sessionRef)));
	return { reviewedMap, toggleFileReviewed };
}
