import { SESSION_IMAGE_MAX_ITEMS } from "@ling/contracts/session";
import {
	appendPendingAttachments,
	type AttachmentIssue,
	type PendingAttachment,
	selectAttachmentFiles,
} from "@renderer/features/sessions/state/image-attachment-policy";
import pLimit from "p-limit";
import { type Dispatch, type SetStateAction, useEffect, useRef, useState } from "react";

export type { PendingAttachment } from "@renderer/features/sessions/state/image-attachment-policy";

/** Optional external attachment state. When passed, the hook operates on it instead of an
 * internal `useState` — lets the session Composer persist attachments per-session in a
 * draft atom. Omit for self-contained use (the home-screen quick start). */
export type AttachmentSource = readonly [PendingAttachment[], Dispatch<SetStateAction<PendingAttachment[]>>];

function readAsDataUrl(file: File, signal: AbortSignal): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		let settled = false;
		const cleanup = () => {
			signal.removeEventListener("abort", abort);
			reader.onload = null;
			reader.onerror = null;
			reader.onabort = null;
		};
		const succeed = () => {
			if (settled) return;
			settled = true;
			const result = reader.result as string;
			cleanup();
			resolve(result);
		};
		const fail = (error: unknown) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};
		const abort = () => {
			if (reader.readyState === FileReader.LOADING) reader.abort();
			fail(signal.reason ?? new DOMException("Attachment read cancelled", "AbortError"));
		};
		reader.onload = succeed;
		reader.onerror = () => fail(reader.error ?? new Error("Attachment read failed"));
		reader.onabort = () => fail(signal.reason ?? new DOMException("Attachment read cancelled", "AbortError"));
		if (signal.aborted) {
			abort();
			return;
		}
		signal.addEventListener("abort", abort, { once: true });
		reader.readAsDataURL(file);
	});
}

export function captureFiles(files: Iterable<File>, limit: number): File[] {
	const captured: File[] = [];
	for (const file of files) {
		captured.push(file);
		if (captured.length >= limit) break;
	}
	return captured;
}

/** Image attachments for a message editor: file-picker adds, clipboard paste, thumbnails
 * state. Outgoing conversion belongs to the message preparation path. Shared by the session
 * composer and the home-screen quick start. */
export function useImageAttachments(source?: AttachmentSource, scopeKey?: string) {
	const internalState = useState<PendingAttachment[]>([]);
	const [attachments, setAttachments] = source ?? internalState;
	const [attachmentIssue, setAttachmentIssue] = useState<AttachmentIssue | null>(null);
	const attachmentsRef = useRef(attachments);
	attachmentsRef.current = attachments;
	const scopeKeyRef = useRef(scopeKey);
	scopeKeyRef.current = scopeKey;
	const addQueueRef = useRef(pLimit(1));
	const addControllersRef = useRef(new Set<AbortController>());

	// changing scope must abort reads owned by the previous draft.
	useEffect(
		() => () => {
			for (const controller of addControllersRef.current) controller.abort();
			addControllersRef.current.clear();
		},
		[scopeKey],
	);

	const addFiles = (files: Iterable<File>): Promise<void> => {
		// No pre-filtering: selectAttachmentFiles rejects non-image types itself and reports
		// an unsupported-type issue, so a dropped PDF fails visibly instead of vanishing.
		const candidates = captureFiles(files, SESSION_IMAGE_MAX_ITEMS + 1);
		const controller = new AbortController();
		addControllersRef.current.add(controller);
		const operationScopeKey = scopeKey;
		const run = async () => {
			if (scopeKeyRef.current !== operationScopeKey || controller.signal.aborted) return;
			setAttachmentIssue(null);
			const selection = selectAttachmentFiles(attachmentsRef.current, candidates);
			const added: PendingAttachment[] = [];
			let issue = selection.issue;
			for (const file of selection.accepted) {
				try {
					const dataUrl = await readAsDataUrl(file, controller.signal);
					added.push({ id: crypto.randomUUID(), dataUrl, mimeType: file.type, name: file.name });
				} catch {
					if (controller.signal.aborted) return;
					issue ??= { code: "read-failed", fileName: file.name };
				}
			}
			if (scopeKeyRef.current !== operationScopeKey) return;
			const committed = appendPendingAttachments(attachmentsRef.current, added);
			attachmentsRef.current = committed.accepted;
			setAttachments(committed.accepted);
			setAttachmentIssue(issue ?? committed.issue);
		};
		return addQueueRef.current(run).finally(() => {
			addControllersRef.current.delete(controller);
		});
	};

	const removeAttachment = (id: string) => {
		const next = attachmentsRef.current.filter((attachment) => attachment.id !== id);
		attachmentsRef.current = next;
		setAttachments(next);
		setAttachmentIssue(null);
	};

	return { attachments, attachmentIssue, addFiles, removeAttachment };
}
