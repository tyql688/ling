import type { SessionDraft } from "@renderer/features/sessions/state/drafts";
import { draftFromComposerProjection, type ComposerProjection } from "./composer-markdown";

export function sameComposerDraft(left: SessionDraft, right: SessionDraft): boolean {
	if (left.text !== right.text) return false;
	for (const key of ["attachments", "fileReferences", "pastedBlocks", "reviewComments"] as const) {
		if (left[key].length !== right[key].length || left[key].some((item, index) => item !== right[key][index]))
			return false;
	}
	return JSON.stringify(left.contextPositions ?? []) === JSON.stringify(right.contextPositions ?? []);
}

/** Publish parsed Markdown and its cursor together, including silent draft loads that normalize the source. */
export function syncComposerProjection(
	projection: ComposerProjection,
	accepted: { current: SessionDraft },
	onChange: (draft: SessionDraft, cursorOffset: number) => void,
	onSelectionChange: (cursorOffset: number) => void,
): void {
	const draft = draftFromComposerProjection(projection);
	if (sameComposerDraft(accepted.current, draft)) {
		onSelectionChange(projection.cursorOffset);
		return;
	}
	accepted.current = draft;
	onChange(draft, projection.cursorOffset);
}
