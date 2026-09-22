import { ATTACHMENT_UPLOAD_MAX_BYTES, attachmentUploadResultSchema } from "@ling/contracts/attachments";

/** Browser files have no Host path. Stream them once and retain the returned durable reference. */
export async function uploadAttachment(cwd: string, file: File, signal: AbortSignal) {
	if (file.size > ATTACHMENT_UPLOAD_MAX_BYTES) throw new Error("Attachment exceeds the 1 GiB upload limit");
	const query = new URLSearchParams({ cwd, name: file.name });
	const response = await fetch(`/api/media/upload?${query}`, {
		method: "POST",
		body: file,
		credentials: "same-origin",
		signal,
	});
	if (!response.ok) throw new Error(`Attachment upload failed (HTTP ${response.status})`);
	return attachmentUploadResultSchema.parse(await response.json()).reference;
}
