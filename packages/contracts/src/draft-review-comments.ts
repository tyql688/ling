import { ABSOLUTE_PATH_MAX_CHARS } from "./path-bounds";

export interface ReviewCommentDraft {
	id: string;
	filePath: string;
	/** Human line range, e.g. "L12-L18" (new side) or "old L4" (pure deletions). */
	rangeLabel: string;
	text: string;
	/** The selected raw diff lines, capped at capture time. */
	excerpt: string;
}

type ReviewCommentSegment =
	| { kind: "text"; text: string }
	| { kind: "comment"; filePath: string; rangeLabel: string; text: string; excerpt: string };

export type ReviewCommentIssue = "count" | "text" | "size";

/** Bound retained cards and the eventual serialized message before it reaches IPC. */
export const REVIEW_COMMENT_MAX_ITEMS = 64;
export const REVIEW_COMMENT_TEXT_MAX_CHARS = 16 * 1024;
const REVIEW_COMMENT_EXCERPT_MAX_CHARS = 64 * 1024;
const REVIEW_COMMENTS_TOTAL_MAX_CHARS = 512 * 1024;
const REVIEW_COMMENT_ID_MAX_CHARS = 128;
const REVIEW_COMMENT_RANGE_MAX_CHARS = 128;

/** A whole review_comment XML block in a user message; attributes on the open tag, body may contain a diff fence. */
const BLOCK_PATTERN = /<review_comment\b([^>]*)>\s*([\s\S]*?)<\/review_comment>/g;
/** `name="value"` attributes on the open tag; values are XML-escaped. */
const ATTRIBUTE_PATTERN = /([a-zA-Z][a-zA-Z0-9_-]*)="([^"]*)"/g;
/** Diff excerpt fence inside the block; open/close backtick runs match in length to prevent nested truncation. */
const FENCE_PATTERN = /(`{3,})diff\n([\s\S]*?)\n\1/;

function escapeAttribute(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function unescapeAttribute(value: string): string {
	return value
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&amp;/g, "&");
}

/** The excerpt rides in a diff fence; a fence longer than any run of backticks inside
 * the excerpt keeps the block self-delimiting. */
function renderBlock(comment: ReviewCommentDraft): string {
	const longestBacktickRun = comment.excerpt.match(/`+/g)?.reduce((max, run) => Math.max(max, run.length), 0) ?? 0;
	const fence = "`".repeat(Math.max(3, longestBacktickRun + 1));
	return [
		`<review_comment file="${escapeAttribute(comment.filePath)}" lines="${escapeAttribute(comment.rangeLabel)}">`,
		comment.text,
		`${fence}diff`,
		comment.excerpt,
		fence,
		"</review_comment>",
	].join("\n");
}

function basicReviewCommentIssue(comment: ReviewCommentDraft): ReviewCommentIssue | null {
	if (comment.text.length > REVIEW_COMMENT_TEXT_MAX_CHARS) return "text";
	if (
		comment.id.length === 0 ||
		comment.id.length > REVIEW_COMMENT_ID_MAX_CHARS ||
		comment.filePath.length === 0 ||
		comment.filePath.length > ABSOLUTE_PATH_MAX_CHARS ||
		comment.rangeLabel.length === 0 ||
		comment.rangeLabel.length > REVIEW_COMMENT_RANGE_MAX_CHARS ||
		comment.excerpt.length > REVIEW_COMMENT_EXCERPT_MAX_CHARS
	)
		return "size";
	return null;
}

function renderedCommentsLength(comments: readonly ReviewCommentDraft[]): number {
	return comments.reduce((total, comment, index) => total + renderBlock(comment).length + (index === 0 ? 0 : 2), 0);
}

export function appendReviewComment(
	current: readonly ReviewCommentDraft[],
	comment: ReviewCommentDraft,
): { comments: ReviewCommentDraft[]; issue: ReviewCommentIssue | null } {
	if (current.length >= REVIEW_COMMENT_MAX_ITEMS) return { comments: [...current], issue: "count" };
	const issue = basicReviewCommentIssue(comment);
	if (issue !== null) return { comments: [...current], issue };
	const separatorLength = current.length === 0 ? 0 : 2;
	if (
		renderedCommentsLength(current) + separatorLength + renderBlock(comment).length >
		REVIEW_COMMENTS_TOTAL_MAX_CHARS
	) {
		return { comments: [...current], issue: "size" };
	}
	return { comments: [...current, comment], issue: null };
}

/** Defensive loader/state-boundary projection for localStorage and atom updates. */
export function selectBoundedReviewComments(comments: readonly ReviewCommentDraft[]): ReviewCommentDraft[] {
	const accepted: ReviewCommentDraft[] = [];
	for (const comment of comments) {
		const result = appendReviewComment(accepted, comment);
		if (result.issue === "count" || (result.issue === "size" && accepted.length >= REVIEW_COMMENT_MAX_ITEMS)) break;
		if (result.issue !== null) continue;
		accepted.push(comment);
	}
	return accepted;
}

/** Final message text: the typed message first, then each review comment block. */
export function mergeReviewComments(base: string | null, comments: readonly ReviewCommentDraft[]): string | null {
	if (selectBoundedReviewComments(comments).length !== comments.length) {
		throw new Error("Review comments exceed the bounded composer limits");
	}
	const parts = [...(base === null ? [] : [base]), ...comments.map(renderBlock)];
	return parts.length === 0 ? null : parts.join("\n\n");
}

function parseAttributes(raw: string): { file?: string; lines?: string } {
	const attributes: { file?: string; lines?: string } = {};
	for (const match of raw.matchAll(ATTRIBUTE_PATTERN)) {
		const name = match[1];
		if (name === "file") attributes.file = unescapeAttribute(match[2] ?? "");
		if (name === "lines") attributes.lines = unescapeAttribute(match[2] ?? "");
		if (attributes.file !== undefined && attributes.lines !== undefined) break;
	}
	return attributes;
}

/** Splits a sent user message back into text and review-comment segments for display.
 * A block missing its required attributes stays visible as plain text — never dropped. */
export function parseReviewCommentSegments(text: string): ReviewCommentSegment[] {
	const segments: ReviewCommentSegment[] = [];
	let cursor = 0;
	let examinedBlocks = 0;
	for (const match of text.matchAll(BLOCK_PATTERN)) {
		if (examinedBlocks >= REVIEW_COMMENT_MAX_ITEMS) break;
		examinedBlocks += 1;
		const index = match.index;
		const attributes = parseAttributes(match[1] ?? "");
		const filePath = attributes.file?.trim();
		const rangeLabel = attributes.lines?.trim();
		if (filePath === undefined || filePath.length === 0 || rangeLabel === undefined || rangeLabel.length === 0) {
			continue;
		}
		const body = match[2] ?? "";
		const fenceMatch = body.match(FENCE_PATTERN);
		const commentText = (fenceMatch ? body.slice(0, fenceMatch.index) : body).trim();
		if (index > cursor) segments.push({ kind: "text", text: text.slice(cursor, index) });
		segments.push({
			kind: "comment",
			filePath,
			rangeLabel,
			text: commentText,
			excerpt: fenceMatch?.[2] ?? "",
		});
		cursor = index + match[0].length;
	}
	if (segments.length === 0) return [{ kind: "text", text }];
	if (cursor < text.length) segments.push({ kind: "text", text: text.slice(cursor) });
	return segments;
}
