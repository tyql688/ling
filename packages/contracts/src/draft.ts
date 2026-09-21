import { z } from "zod";
import {
	REVIEW_COMMENT_MAX_ITEMS,
	selectBoundedReviewComments,
	type ReviewCommentDraft,
} from "./draft-review-comments";
import { ABSOLUTE_PATH_MAX_CHARS } from "./path-bounds";
import { PROJECT_FILE_REFERENCE_MAX_ITEMS } from "./project";
import { createProjectFileSchemas } from "./project-file-requests";
import { SESSION_MESSAGE_TEXT_MAX_CHARS } from "./session";

/** One entry may use the previous renderer's complete draft budget; publication never truncates input. */
export const DRAFT_MAX_CHARS = 1024 * 1024;
/** Bound the initial shared snapshot and retained recovery versions well below the Host frame budget. */
export const DRAFT_STORE_MAX_CHARS = 4 * 1024 * 1024;
export const DRAFT_STORE_MAX_ITEMS = 256;
export const DRAFT_CONFLICT_MAX_ITEMS = 64;
/** Keys include the project path and session identity; the legacy new-conversation key remains valid. */
export const DRAFT_KEY_MAX_CHARS = ABSOLUTE_PATH_MAX_CHARS + 2048;
export const PASTED_TEXT_BLOCK_MAX_ITEMS = 64;
const entryId = z.string().min(1).max(256);
const fileTargets = createProjectFileSchemas().projectFileReferenceTargetSchema.options;
const pendingFileSchema = z.discriminatedUnion("scope", [
	fileTargets[0].extend({ id: entryId, directory: z.boolean().optional() }),
	fileTargets[1].extend({ id: entryId, directory: z.boolean().optional() }),
]);
export type PendingFileReference = z.infer<typeof pendingFileSchema>;
export interface PastedTextBlock {
	id: string;
	text: string;
}
/** UTF-16 offset in Markdown before inline context is expanded for submission. */
export interface DraftContextPosition {
	kind: "file" | "image" | "paste" | "review";
	id: string;
	offset: number;
}
const reviewCommentSchema: z.ZodType<ReviewCommentDraft> = z.strictObject({
	id: z.string(),
	filePath: z.string(),
	rangeLabel: z.string(),
	text: z.string(),
	excerpt: z.string(),
});
export const persistedDraftSchema = z
	.strictObject({
		version: z.literal(2),
		text: z.string().max(SESSION_MESSAGE_TEXT_MAX_CHARS),
		contextPositions: z
			.array(
				z.strictObject({
					kind: z.enum(["file", "paste", "review"]),
					id: entryId,
					offset: z.number().int().nonnegative(),
				}),
			)
			.max(256),
		fileReferences: z.array(pendingFileSchema).max(PROJECT_FILE_REFERENCE_MAX_ITEMS),
		pastedBlocks: z
			.array(z.strictObject({ id: entryId, text: z.string().min(1).max(SESSION_MESSAGE_TEXT_MAX_CHARS) }))
			.max(PASTED_TEXT_BLOCK_MAX_ITEMS),
		reviewComments: z.array(reviewCommentSchema).max(REVIEW_COMMENT_MAX_ITEMS),
	})
	.superRefine((draft, ctx) => {
		if (draft.pastedBlocks.reduce((size, block) => size + block.text.length, 0) > SESSION_MESSAGE_TEXT_MAX_CHARS)
			ctx.addIssue({ code: "custom", message: "Pasted draft context exceeds the message limit" });
		if (selectBoundedReviewComments(draft.reviewComments).length !== draft.reviewComments.length)
			ctx.addIssue({ code: "custom", message: "Draft review comments exceed the composer limits" });
		const remaining = new Set([
			...draft.fileReferences.map((value) => `file:${value.id}`),
			...draft.pastedBlocks.map((value) => `paste:${value.id}`),
			...draft.reviewComments.map((value) => `review:${value.id}`),
		]);
		for (const position of draft.contextPositions) {
			if (position.offset > draft.text.length || !remaining.delete(`${position.kind}:${position.id}`))
				ctx.addIssue({ code: "custom", message: "Draft context position does not identify its content" });
		}
		if (JSON.stringify(draft).length > DRAFT_MAX_CHARS)
			ctx.addIssue({ code: "custom", message: "Draft exceeds its storage limit" });
	});
export type PersistedDraft = z.infer<typeof persistedDraftSchema>;
export const draftKeySchema = z.string().min(1).max(DRAFT_KEY_MAX_CHARS);
const draftRevisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const writeDraftSchema = z.strictObject({
	key: draftKeySchema,
	baseRevision: draftRevisionSchema,
	draft: persistedDraftSchema.nullable(),
	/** Explicit conflict resolution preserves the shared draft it replaces. */
	preservePrevious: z.literal(true).optional(),
});
export type WriteDraft = z.infer<typeof writeDraftSchema>;
export interface StoredDraft {
	key: string;
	revision: number;
	draft: PersistedDraft | null;
	updatedAt: number;
}
export interface DraftConflict {
	id: string;
	key: string;
	draft: PersistedDraft;
	baseRevision: number;
	savedAt: number;
}
export interface DraftSnapshot {
	drafts: StoredDraft[];
	conflicts: DraftConflict[];
	issues: { key: string; message: string }[];
}
export type WriteDraftResult =
	| { status: "saved"; current: StoredDraft }
	| { status: "conflict"; current: StoredDraft; recovery: DraftConflict | null };
export const resolveDraftConflictSchema = z.strictObject({
	id: z.string().length(64),
	baseRevision: draftRevisionSchema,
	choice: z.enum(["recover", "discard"]),
});
export type ResolveDraftConflict = z.infer<typeof resolveDraftConflictSchema>;
export type DraftEvent = { type: "updated"; current: StoredDraft } | { type: "conflictsChanged" };
