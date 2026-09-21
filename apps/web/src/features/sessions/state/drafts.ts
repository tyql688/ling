import {
	DRAFT_KEY_MAX_CHARS,
	PASTED_TEXT_BLOCK_MAX_ITEMS,
	type DraftContextPosition,
	type PastedTextBlock,
	type PendingFileReference,
	type PersistedDraft,
} from "@ling/contracts/draft";
import { ABSOLUTE_PATH_MAX_CHARS } from "@ling/contracts/path-bounds";
import { PROJECT_FILE_REFERENCE_MAX_ITEMS, PROJECT_RELATIVE_PATH_MAX_CHARS } from "@ling/contracts/project";
import { SESSION_IMAGE_MAX_ITEMS, SESSION_MESSAGE_TEXT_MAX_CHARS } from "@ling/contracts/session";

import {
	REVIEW_COMMENT_MAX_ITEMS,
	selectBoundedReviewComments,
	type ReviewCommentDraft,
} from "@ling/contracts/draft-review-comments";
import {
	appendPendingAttachments,
	MAX_DRAFT_IMAGE_DATA_URL_BYTES,
	type PendingAttachment,
} from "@renderer/features/sessions/state/image-attachment-policy";
import { isWindows } from "@renderer/lib/platform";
import { atom } from "jotai";
import { normalizeContextPositions, rebaseContextPositions, type DraftContext } from "./draft-context";

export interface SessionDraft {
	text: string;
	contextPositions?: DraftContextPosition[];
	attachments: PendingAttachment[];
	fileReferences: PendingFileReference[];
	pastedBlocks: PastedTextBlock[];
	/** Pending review line comments (review/review-comment-blocks.ts merges them on send). */
	reviewComments: ReviewCommentDraft[];
}

/** Stable empty-draft reference, shared by clear/init, so no per-session new literal causes pointless re-renders. */
export const EMPTY_DRAFT: SessionDraft = {
	text: "",
	attachments: [],
	fileReferences: [],
	pastedBlocks: [],
	reviewComments: [],
};

const DRAFT_ENTRY_ID_MAX_CHARS = 256;
const MAX_PERSISTED_ARRAY_CANDIDATES = 256;

function isEmptyPersistedDraft(
	draft: Pick<SessionDraft, "text" | "fileReferences" | "pastedBlocks" | "reviewComments">,
): boolean {
	return (
		draft.text === "" &&
		draft.fileReferences.length === 0 &&
		draft.pastedBlocks.length === 0 &&
		draft.reviewComments.length === 0
	);
}

export function isEmptySessionDraft(draft: SessionDraft): boolean {
	return isEmptyPersistedDraft(draft) && draft.attachments.length === 0;
}

function validPersistedFileReference(value: unknown): value is PendingFileReference {
	if (
		!value ||
		typeof value !== "object" ||
		typeof (value as Partial<PendingFileReference>).id !== "string" ||
		(value as Partial<PendingFileReference>).id?.length === 0 ||
		((value as Partial<PendingFileReference>).id?.length ?? 0) > DRAFT_ENTRY_ID_MAX_CHARS ||
		typeof (value as Partial<PendingFileReference>).path !== "string"
	)
		return false;
	const reference = value as Partial<PendingFileReference>;
	const path = reference.path;
	if (path === undefined || path.length === 0 || path.includes("\0")) return false;
	if (reference.scope === "external") {
		return (
			path.length <= ABSOLUTE_PATH_MAX_CHARS &&
			(path.startsWith("/") || (isWindows && (/^[A-Za-z]:[/\\]/u.test(path) || path.startsWith("\\\\"))))
		);
	}
	if (
		reference.scope !== "project" ||
		path.length > PROJECT_RELATIVE_PATH_MAX_CHARS ||
		(isWindows && path.includes("\\")) ||
		path.startsWith("/") ||
		path.endsWith("/") ||
		!path.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
	)
		return false;
	if (reference.lineRange === undefined) return true;
	return (
		reference.lineRange !== null &&
		typeof reference.lineRange === "object" &&
		Number.isSafeInteger(reference.lineRange.start) &&
		reference.lineRange.start > 0 &&
		Number.isSafeInteger(reference.lineRange.end) &&
		reference.lineRange.end >= reference.lineRange.start
	);
}

function loadFileReferences(value: unknown): PendingFileReference[] {
	if (!Array.isArray(value)) return [];
	const accepted: PendingFileReference[] = [];
	let examined = 0;
	for (const reference of value) {
		if (examined >= MAX_PERSISTED_ARRAY_CANDIDATES || accepted.length >= PROJECT_FILE_REFERENCE_MAX_ITEMS) break;
		examined += 1;
		if (validPersistedFileReference(reference)) accepted.push(reference);
	}
	return accepted;
}

function selectBoundedPastedBlocks(blocks: readonly PastedTextBlock[]): PastedTextBlock[] {
	const accepted: PastedTextBlock[] = [];
	let textChars = 0;
	for (const block of blocks) {
		if (accepted.length >= PASTED_TEXT_BLOCK_MAX_ITEMS) break;
		if (
			block.id.length === 0 ||
			block.id.length > DRAFT_ENTRY_ID_MAX_CHARS ||
			block.text.length === 0 ||
			block.text.length > SESSION_MESSAGE_TEXT_MAX_CHARS ||
			textChars + block.text.length > SESSION_MESSAGE_TEXT_MAX_CHARS
		)
			continue;
		accepted.push(block);
		textChars += block.text.length;
	}
	return accepted;
}

function loadPastedBlocks(value: unknown): PastedTextBlock[] {
	if (!Array.isArray(value)) return [];
	const candidates: PastedTextBlock[] = [];
	let examined = 0;
	for (const block of value) {
		if (examined >= MAX_PERSISTED_ARRAY_CANDIDATES) break;
		examined += 1;
		if (
			block &&
			typeof block === "object" &&
			typeof (block as Partial<PastedTextBlock>).id === "string" &&
			typeof (block as Partial<PastedTextBlock>).text === "string"
		) {
			candidates.push(block as PastedTextBlock);
		}
	}
	return selectBoundedPastedBlocks(candidates);
}

function loadReviewComments(value: unknown): ReviewCommentDraft[] {
	if (!Array.isArray(value)) return [];
	const candidates: ReviewCommentDraft[] = [];
	let examined = 0;
	for (const comment of value) {
		if (examined >= MAX_PERSISTED_ARRAY_CANDIDATES || candidates.length >= REVIEW_COMMENT_MAX_ITEMS) break;
		examined += 1;
		if (
			comment &&
			typeof comment === "object" &&
			typeof (comment as Partial<ReviewCommentDraft>).id === "string" &&
			typeof (comment as Partial<ReviewCommentDraft>).filePath === "string" &&
			typeof (comment as Partial<ReviewCommentDraft>).rangeLabel === "string" &&
			typeof (comment as Partial<ReviewCommentDraft>).text === "string" &&
			typeof (comment as Partial<ReviewCommentDraft>).excerpt === "string"
		) {
			candidates.push(comment as ReviewCommentDraft);
		}
	}
	return selectBoundedReviewComments(candidates);
}

/** Clipboard HTML is an external boundary; reuse the draft owner's item validation. */
export function parseDraftContext(raw: string): DraftContext | null {
	if (raw.length > MAX_DRAFT_IMAGE_DATA_URL_BYTES) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object") return null;
		const { kind, value } = parsed as { kind?: unknown; value?: unknown };
		if (kind === "file") {
			const accepted = loadFileReferences([value])[0];
			return accepted ? { kind, value: accepted } : null;
		}
		if (kind === "paste") {
			const accepted = loadPastedBlocks([value])[0];
			return accepted ? { kind, value: accepted } : null;
		}
		if (kind === "review") {
			const accepted = loadReviewComments([value])[0];
			return accepted ? { kind, value: accepted } : null;
		}
		if (kind === "image" && value && typeof value === "object") {
			const candidate = value as Partial<PendingAttachment>;
			if (
				typeof candidate.id !== "string" ||
				typeof candidate.dataUrl !== "string" ||
				typeof candidate.mimeType !== "string"
			)
				return null;
			if (!candidate.dataUrl.startsWith(`data:${candidate.mimeType};base64,`)) return null;
			const accepted = appendPendingAttachments([], [candidate as PendingAttachment]).accepted[0];
			return accepted ? { kind, value: accepted } : null;
		}
		return null;
	} catch {
		return null;
	}
}

/** Reject editor transactions that the existing draft owner would otherwise trim. */
export function draftFitsLimits(draft: SessionDraft): boolean {
	if (draft.text.length > SESSION_MESSAGE_TEXT_MAX_CHARS) return false;
	const normalized = normalizeSessionDraft(draft);
	return (["attachments", "fileReferences", "pastedBlocks", "reviewComments"] as const).every(
		(key) => normalized[key].length === draft[key].length,
	);
}

/** Decode one persisted entry independently so damaged context cannot erase other drafts. */
export function restoreSessionDraft(value: unknown): { draft: SessionDraft | null; partial: boolean } {
	if (!value || typeof value !== "object" || Array.isArray(value)) return { draft: null, partial: true };
	const stored = value as Partial<PersistedDraft>;
	if (
		(stored.version !== undefined && stored.version !== 2) ||
		typeof stored.text !== "string" ||
		stored.text.length > SESSION_MESSAGE_TEXT_MAX_CHARS
	)
		return { draft: null, partial: true };
	const draft: SessionDraft = {
		text: stored.text,
		attachments: [],
		fileReferences: loadFileReferences(stored.fileReferences),
		pastedBlocks: loadPastedBlocks(stored.pastedBlocks),
		reviewComments: loadReviewComments(stored.reviewComments),
	};
	draft.contextPositions = normalizeContextPositions(stored.contextPositions, draft);
	const partial = (["fileReferences", "pastedBlocks", "reviewComments", "contextPositions"] as const).some((key) => {
		const source = stored[key];
		// Drafts may omit any of these fields; absence is a supported format.
		return source !== undefined && (!Array.isArray(source) || source.length !== draft[key]?.length);
	});
	return { draft: isEmptySessionDraft(draft) ? null : draft, partial };
}

export function validDraftKey(key: string): boolean {
	return key.length > 0 && key.length <= DRAFT_KEY_MAX_CHARS;
}

function normalizeSessionDraft(draft: SessionDraft, previous?: SessionDraft): SessionDraft {
	const normalized: SessionDraft = {
		text: draft.text.slice(0, SESSION_MESSAGE_TEXT_MAX_CHARS),
		attachments: appendPendingAttachments([], draft.attachments.slice(0, SESSION_IMAGE_MAX_ITEMS + 1)).accepted,
		fileReferences: loadFileReferences(draft.fileReferences),
		pastedBlocks: selectBoundedPastedBlocks(draft.pastedBlocks),
		reviewComments: selectBoundedReviewComments(draft.reviewComments),
	};
	const positions =
		previous && previous.text !== draft.text && previous.contextPositions === draft.contextPositions
			? rebaseContextPositions(previous.text, draft.text, draft.contextPositions ?? [])
			: draft.contextPositions;
	return { ...normalized, contextPositions: normalizeContextPositions(positions, normalized) };
}

function normalizeDraftStore(
	current: Record<string, SessionDraft>,
	requested: Record<string, SessionDraft>,
): Record<string, SessionDraft> {
	const normalized: Record<string, SessionDraft> = {};
	for (const [key, requestedDraft] of Object.entries(requested)) {
		if (!validDraftKey(key)) continue;
		const draft =
			current[key] === requestedDraft ? requestedDraft : normalizeSessionDraft(requestedDraft, current[key]);
		if (!isEmptySessionDraft(draft)) Object.defineProperty(normalized, key, { value: draft, enumerable: true });
	}
	return normalized;
}

const baseDraftsAtom = atom<Record<string, SessionDraft>>({});

/** Per-session composer drafts (text + pending image/file attachments).
 *
 * Without this, switching sessions wipes a half-typed message: the Composer's `text` and
 * `attachments` were plain `useState`, so any route through the empty home screen
 * (`activeSessionRef` → null → `EmptyState` renders instead of Composer) unmounted it and
 * discarded the lot — and switching directly between two sessions bled one draft into the
 * other. Keyed by `sessionKey(ref)` so each conversation keeps (and only shows) its own draft,
 * restored on return. Implicitly cleared when the message is sent (Composer resets both
 * fields back to empty).
 *
 * Durable content is synchronized by the renderer-owned Host draft connection; images stay transient. */
export const draftsAtom = atom(
	(get) => get(baseDraftsAtom),
	(
		get,
		set,
		update: Record<string, SessionDraft> | ((current: Record<string, SessionDraft>) => Record<string, SessionDraft>),
	) => {
		const current = get(baseDraftsAtom);
		const requested = typeof update === "function" ? update(current) : update;
		const next = normalizeDraftStore(current, requested);
		set(baseDraftsAtom, next);
	},
);

/** A view owns this atom; the draft remains in the shared store when that view unmounts. */
export function createSessionDraftAtom(key: string) {
	return atom(
		(get) => get(draftsAtom)[key] ?? EMPTY_DRAFT,
		(_get, set, update: SessionDraft | ((current: SessionDraft) => SessionDraft)) => {
			set(draftsAtom, (drafts) => {
				// A conversation without user input has no retained draft entry.
				const current = drafts[key] ?? EMPTY_DRAFT;
				const next = typeof update === "function" ? update(current) : update;
				return next === current ? drafts : { ...drafts, [key]: next };
			});
		},
	);
}

export const NEW_CONVERSATION_DRAFT_KEY = "new-conversation";

/** The durable projection deliberately excludes images and their inline positions. */
export function persistSessionDraft(draft: SessionDraft): PersistedDraft | null {
	if (isEmptyPersistedDraft(draft)) return null;
	return {
		version: 2,
		text: draft.text,
		contextPositions: (draft.contextPositions ?? []).filter(
			(position): position is PersistedDraft["contextPositions"][number] => position.kind !== "image",
		),
		fileReferences: draft.fileReferences,
		pastedBlocks: draft.pastedBlocks,
		reviewComments: draft.reviewComments,
	};
}
