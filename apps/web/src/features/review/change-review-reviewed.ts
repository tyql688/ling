import type { ChangeReviewFile } from "@ling/contracts/git";
import type { ReviewedMap, ReviewedMark } from "@ling/contracts/user-state";
import { parseSessionKey } from "@ling/contracts/session-ref";
import { mutateUserStateAtom, userStateAtom } from "@renderer/lib/user-state/state";
import { atom } from "jotai";
import { atomFamily } from "jotai-family";

export type { ReviewedMap } from "@ling/contracts/user-state";
const EMPTY_REVIEWED: ReviewedMap = {};
export const reviewedStateAtomFamily = atomFamily((key: string) =>
	atom(
		(get) => get(userStateAtom).reviewed[key] ?? EMPTY_REVIEWED,
		(get, set, file: ChangeReviewFile) => {
			const ref = parseSessionKey(key);
			if (!ref) throw new Error("Reviewed progress requires a session reference");
			const current = get(userStateAtom).reviewed[key] ?? EMPTY_REVIEWED;
			set(mutateUserStateAtom, [
				{
					type: "reviewMark",
					ref,
					path: file.path,
					mark: isFileReviewed(current, file) ? null : reviewedMarkFor(file),
				},
			]);
		},
	),
);
/** Host deletion removes durable progress; renderer cleanup only releases per-session selectors. */
export function forgetReviewedMaps(keys: readonly string[]) {
	for (const key of new Set(keys)) reviewedStateAtomFamily.remove(key);
}

function reviewedMarkFor(file: ChangeReviewFile): ReviewedMark {
	return {
		status: file.status,
		additions: file.additions ?? null,
		deletions: file.deletions ?? null,
		contentTag: file.contentTag ?? null,
	};
}

/** Reviewed only while the stored mark still matches the file's current change identity.
 * The content tag is the precise signal (two different edits with equal line counts get
 * different tags); status and counts guard the tagless cases. */
export function isFileReviewed(map: ReviewedMap, file: ChangeReviewFile): boolean {
	const mark = map[file.path];
	if (!mark) return false;
	const current = reviewedMarkFor(file);
	return (
		mark.status === current.status &&
		mark.additions === current.additions &&
		mark.deletions === current.deletions &&
		mark.contentTag === current.contentTag
	);
}

export function countReviewed(map: ReviewedMap, files: readonly ChangeReviewFile[]): number {
	return files.reduce((count, file) => (isFileReviewed(map, file) ? count + 1 : count), 0);
}
