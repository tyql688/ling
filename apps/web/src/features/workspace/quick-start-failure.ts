import type { SessionDraft } from "@renderer/features/sessions/state/drafts";

function hasDraftContent(draft: SessionDraft | undefined): boolean {
	return (
		draft !== undefined &&
		(draft.text.length > 0 ||
			draft.attachments.length > 0 ||
			draft.fileReferences.length > 0 ||
			draft.pastedBlocks.length > 0 ||
			draft.reviewComments.length > 0)
	);
}

/** A send that fails after its text already left the screen (first send after the new session
 * composer replaces Home; an edited message whose session was already rewound). Restore the
 * submitted draft only when the user has not already typed a newer one. */
export function restoreFailedQuickStartDraft(
	drafts: Record<string, SessionDraft>,
	draftKey: string,
	failedDraft: SessionDraft,
): Record<string, SessionDraft> {
	if (hasDraftContent(drafts[draftKey])) return drafts;
	return { ...drafts, [draftKey]: failedDraft };
}
