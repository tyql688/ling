import type { ImageAttachment } from "@ling/contracts/session-messages";
import {
	SESSION_IMAGE_MAX_BYTES,
	SESSION_IMAGE_MAX_ITEMS,
	sessionImageMimeTypeSchema,
	SESSION_IMAGE_TOTAL_MAX_BYTES,
} from "@ling/contracts/session";

/**
 * Total byte cap for draft-side data URLs: reuses the session's decoded total budget.
 * Base64 inflation makes strings longer; reusing the decoded budget is deliberately stricter,
 * so drafts can't fill up first and then get rejected at send time.
 */
export const MAX_DRAFT_IMAGE_DATA_URL_BYTES = SESSION_IMAGE_TOTAL_MAX_BYTES;

export interface PendingAttachment {
	id: string;
	dataUrl: string;
	mimeType: string;
	name?: string;
}

export type AttachmentIssue =
	| { code: "count" }
	| { code: "file-size"; fileName: string }
	| { code: "unsupported-type" }
	| { code: "total-size" }
	| { code: "read-failed"; fileName: string };

interface AttachmentFileCandidate {
	name: string;
	type: string;
	size: number;
}

function isSupportedSessionImageMimeType(value: string): value is string {
	return sessionImageMimeTypeSchema.safeParse(value).success;
}

interface AttachmentSelection<T> {
	accepted: T[];
	issue: AttachmentIssue | null;
}

function dataUrlPrefixBytes(mimeType: string): number {
	return `data:${mimeType};base64,`.length;
}

function encodedDataUrlUpperBound(file: AttachmentFileCandidate): number {
	return dataUrlPrefixBytes(file.type) + Math.ceil(file.size / 3) * 4;
}

export function attachmentDataUrlBytes(attachments: readonly PendingAttachment[]): number {
	return attachments.reduce((total, attachment) => total + attachment.dataUrl.length, 0);
}

/**
 * Rejects oversized input before FileReader creates a second in-memory copy. The
 * exact post-read policy below remains authoritative because File metadata and
 * concurrent attachment changes are external input.
 */
export function selectAttachmentFiles<T extends AttachmentFileCandidate>(
	current: readonly PendingAttachment[],
	files: readonly T[],
): AttachmentSelection<T> {
	const accepted: T[] = [];
	let projectedBytes = attachmentDataUrlBytes(current);
	let issue: AttachmentIssue | null = null;

	for (const file of files) {
		if (!isSupportedSessionImageMimeType(file.type)) {
			issue ??= { code: "unsupported-type" };
			continue;
		}
		if (current.length + accepted.length >= SESSION_IMAGE_MAX_ITEMS) {
			issue ??= { code: "count" };
			break;
		}
		if (file.size > SESSION_IMAGE_MAX_BYTES) {
			issue ??= { code: "file-size", fileName: file.name };
			continue;
		}
		const projectedFileBytes = encodedDataUrlUpperBound(file);
		if (projectedBytes + projectedFileBytes > MAX_DRAFT_IMAGE_DATA_URL_BYTES) {
			issue ??= { code: "total-size" };
			continue;
		}
		accepted.push(file);
		projectedBytes += projectedFileBytes;
	}

	return { accepted, issue };
}

/** Revalidates the exact data URLs at the state-owner boundary. */
export function appendPendingAttachments(
	current: readonly PendingAttachment[],
	candidates: readonly PendingAttachment[],
): AttachmentSelection<PendingAttachment> {
	const accepted: PendingAttachment[] = [];
	let projectedBytes = attachmentDataUrlBytes(current);
	let issue: AttachmentIssue | null = null;

	for (const candidate of candidates) {
		if (!isSupportedSessionImageMimeType(candidate.mimeType)) {
			issue ??= { code: "unsupported-type" };
			continue;
		}
		if (current.length + accepted.length >= SESSION_IMAGE_MAX_ITEMS) {
			issue ??= { code: "count" };
			break;
		}
		if (projectedBytes + candidate.dataUrl.length > MAX_DRAFT_IMAGE_DATA_URL_BYTES) {
			issue ??= { code: "total-size" };
			continue;
		}
		accepted.push(candidate);
		projectedBytes += candidate.dataUrl.length;
	}

	return { accepted: [...current, ...accepted], issue };
}

function toImageAttachment(attachment: PendingAttachment): ImageAttachment {
	if (!isSupportedSessionImageMimeType(attachment.mimeType)) throw new Error("Unsupported draft image type");
	const base64 = attachment.dataUrl.slice(attachment.dataUrl.indexOf(",") + 1);
	return { type: "image", data: base64, mimeType: attachment.mimeType };
}

/** Converts an admitted snapshot without reading mutable editor state. */
export function toImageAttachments(attachments: readonly PendingAttachment[]): ImageAttachment[] {
	return attachments.map(toImageAttachment);
}
