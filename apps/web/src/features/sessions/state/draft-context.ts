import type { DraftContextPosition, PastedTextBlock } from "@ling/contracts/draft";
import type { PendingFileReference } from "@ling/contracts/draft";
import type { SessionDraft } from "./drafts";

import type { ReviewCommentDraft } from "@ling/contracts/draft-review-comments";
import type { PendingAttachment } from "@renderer/features/sessions/state/image-attachment-policy";

export type DraftContext =
	| { kind: "file"; value: PendingFileReference }
	| { kind: "image"; value: PendingAttachment }
	| { kind: "paste"; value: PastedTextBlock }
	| { kind: "review"; value: ReviewCommentDraft };

export function draftContexts(draft: SessionDraft): DraftContext[] {
	return [
		...draft.pastedBlocks.map((value): DraftContext => ({ kind: "paste", value })),
		...draft.reviewComments.map((value): DraftContext => ({ kind: "review", value })),
		...draft.fileReferences.map((value): DraftContext => ({ kind: "file", value })),
		...draft.attachments.map((value): DraftContext => ({ kind: "image", value })),
	];
}

export function contextKey(context: { kind: DraftContext["kind"]; id: string }): string {
	return `${context.kind}:${context.id}`;
}

/** Missing positions are legitimate for legacy drafts and context inserted outside the editor. */
export function normalizeContextPositions(value: unknown, draft: SessionDraft): DraftContextPosition[] {
	if (!Array.isArray(value)) return [];
	const remaining = new Set(
		draftContexts(draft).map((context) => contextKey({ kind: context.kind, id: context.value.id })),
	);
	const positions: DraftContextPosition[] = [];
	// Bound metadata inspection to the persisted draft's candidate budget.
	for (const candidate of value.slice(0, 256)) {
		if (!candidate || typeof candidate !== "object") continue;
		const position = candidate as Partial<DraftContextPosition>;
		if (typeof position.kind !== "string" || typeof position.id !== "string" || typeof position.offset !== "number")
			continue;
		if (!Number.isSafeInteger(position.offset) || position.offset < 0 || position.offset > draft.text.length) continue;
		const key = contextKey(position as DraftContextPosition);
		if (!remaining.delete(key)) continue;
		positions.push({ kind: position.kind, id: position.id, offset: position.offset });
	}
	return positions.sort((left, right) => left.offset - right.offset);
}

/** Rebase metadata when an external Pi/history command replaces Markdown without an editor transaction. */
export function rebaseContextPositions(
	before: string,
	after: string,
	positions: readonly DraftContextPosition[],
): DraftContextPosition[] {
	let prefix = 0;
	while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
	let suffix = 0;
	while (
		suffix < before.length - prefix &&
		suffix < after.length - prefix &&
		before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
	)
		suffix += 1;
	return positions.map((position) => ({
		...position,
		offset:
			position.offset <= prefix
				? position.offset
				: position.offset >= before.length - suffix
					? position.offset + after.length - before.length
					: after.length - suffix,
	}));
}
