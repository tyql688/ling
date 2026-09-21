import { SESSION_MESSAGE_TEXT_MAX_CHARS, type SessionQueuedMessage } from "@ling/contracts/session";
import type { ImageAttachment } from "@ling/contracts/session-messages";
import { mergeReviewComments } from "@ling/contracts/draft-review-comments";
import { fileReferenceLine, type MessageFileReference } from "@ling/contracts/file-reference-text";
import { contextKey, draftContexts, type DraftContext } from "@renderer/features/sessions/state/draft-context";
import { draftFitsLimits, type SessionDraft } from "@renderer/features/sessions/state/drafts";
import { fileReferenceTarget, mergeFileReferences } from "./composer-file-references";
import { toImageAttachments } from "./image-attachment-policy";
import { submitMessageText } from "./message-text";
import { mergePastedBlocks } from "./pasted-text";

export interface ComposerMessage {
	text: string;
	images: ImageAttachment[];
	fileReferences: MessageFileReference[];
	submittedText: string | null;
}

export type ComposerMessagePreparation =
	{ status: "empty" } | { status: "tooLong" } | { status: "ready"; message: ComposerMessage };

function contextText(context: DraftContext): string {
	switch (context.kind) {
		case "file":
			return mergeFileReferences(null, [context.value])!;
		case "paste":
			return `\n\n${mergePastedBlocks(null, [context.value])!}\n\n`;
		case "review":
			return `\n\n${mergeReviewComments(null, [context.value])!}\n\n`;
		case "image":
			return "";
	}
}

/** Legacy/external context without a position retains its established append order. */
function expandDraftContext(draft: SessionDraft): { text: string | null; fileReferences: MessageFileReference[] } {
	const remaining = new Map(
		draftContexts(draft).map((context) => [contextKey({ kind: context.kind, id: context.value.id }), context]),
	);
	let from = 0;
	let text = "";
	const fileReferences: MessageFileReference[] = [];
	for (const position of draft.contextPositions ?? []) {
		const key = contextKey(position);
		const context = remaining.get(key);
		if (!context) throw new Error("Draft context position has no matching item");
		text += draft.text.slice(from, position.offset);
		if (context.kind === "file")
			fileReferences.push({ ...fileReferenceTarget(context.value), textOffset: text.length });
		text += contextText(context);
		from = position.offset;
		remaining.delete(key);
	}
	text += draft.text.slice(from);
	const trailing = [...remaining.values()];
	let body = mergeReviewComments(
		mergePastedBlocks(
			submitMessageText(text),
			trailing.flatMap((context) => (context.kind === "paste" ? [context.value] : [])),
		),
		trailing.flatMap((context) => (context.kind === "review" ? [context.value] : [])),
	);
	const positional = fileReferences.length > 0;
	for (const context of trailing) {
		if (context.kind !== "file") continue;
		const offset = body === null ? 0 : body.length + 1;
		fileReferences.push({ ...fileReferenceTarget(context.value), ...(positional ? { textOffset: offset } : {}) });
		body = mergeFileReferences(body, [context.value]);
	}
	return { text: body, fileReferences };
}

/** Send and queued editing must project text and structured attachments from the same snapshot. */
export function prepareComposerMessage(draft: SessionDraft): ComposerMessagePreparation {
	const submittedText = submitMessageText(draft.text);
	const { text, fileReferences } = expandDraftContext(draft);
	if (text === null && draft.attachments.length === 0) return { status: "empty" };
	if (text !== null && text.length > SESSION_MESSAGE_TEXT_MAX_CHARS) return { status: "tooLong" };
	return {
		status: "ready",
		message: {
			// Image-only submissions retain the existing empty text request field.
			text: text ?? "",
			images: toImageAttachments(draft.attachments),
			fileReferences,
			submittedText,
		},
	};
}

/** Restore whole unsent messages without overwriting newer input or silently trimming their context. */
export function appendUnsentMessages(
	current: SessionDraft,
	messages: readonly SessionQueuedMessage[],
): { draft: SessionDraft; omitted: number } {
	let draft = current;
	let omitted = 0;
	for (const message of messages) {
		const separator = draft.text === "" || message.draftText === "" ? "" : "\n\n";
		const offset = draft.text.length + separator.length;
		const references = message.fileReferences.map((reference) => ({
			...fileReferenceTarget(reference),
			id: crypto.randomUUID(),
		}));
		const attachments = message.images.map((image) => ({
			id: crypto.randomUUID(),
			dataUrl: `data:${image.mimeType};base64,${image.data}`,
			mimeType: image.mimeType,
		}));
		let removedChars = 0;
		const positions = message.fileReferences.flatMap((reference, index) => {
			// Legacy references keep their trailing representation. Positioned metadata
			// addresses the expanded text, while draftText has the reference tokens removed.
			if (reference.textOffset === undefined) return [];
			const position = {
				kind: "file" as const,
				id: references[index]!.id,
				offset: offset + reference.textOffset - removedChars,
			};
			removedChars += fileReferenceLine(reference).length;
			return [position];
		});
		const next: SessionDraft = {
			...draft,
			text: `${draft.text}${separator}${message.draftText}`,
			attachments: [...draft.attachments, ...attachments],
			fileReferences: [...draft.fileReferences, ...references],
			contextPositions: [
				...(draft.contextPositions ?? []),
				...positions,
				...attachments.map((attachment) => ({
					kind: "image" as const,
					id: attachment.id,
					offset: offset + message.draftText.length,
				})),
			],
		};
		if (!draftFitsLimits(next) || prepareComposerMessage(next).status === "tooLong") omitted += 1;
		else draft = next;
	}
	return { draft, omitted };
}
