import { z } from "zod";
import { createProjectFileSchemas } from "./project-file-requests";
import { portableAbsolutePathSchema } from "./path-validation";
import type { ProjectFileReferenceTarget } from "./project";

/** Uploads stream to disk; this bounds one transfer, not model input or local file references. */
export const ATTACHMENT_UPLOAD_MAX_BYTES = 1024 * 1024 * 1024;
export const attachmentFileRequestSchema = z.strictObject({
	cwd: portableAbsolutePathSchema("Project path"),
	reference: createProjectFileSchemas().projectFileReferenceTargetSchema,
});
export const attachmentUploadRequestSchema = z.strictObject({
	cwd: portableAbsolutePathSchema("Project path"),
	name: z.string().min(1).max(1024),
});
export const attachmentUploadResultSchema = z.strictObject({
	reference: createProjectFileSchemas().projectFileReferenceTargetSchema,
});

export function attachmentFileUrl(cwd: string, reference: ProjectFileReferenceTarget, download = false): string {
	const query = new URLSearchParams({ cwd, scope: reference.scope, path: reference.path });
	if (download) query.set("download", "1");
	return `/api/media/file?${query}`;
}

/** Browser preview support is independent of Pi's accepted model inputs. */
const mediaTypes: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	avif: "image/avif",
	bmp: "image/bmp",
	svg: "image/svg+xml",
	ico: "image/x-icon",
	mp4: "video/mp4",
	webm: "video/webm",
	mov: "video/quicktime",
	m4v: "video/mp4",
	ogv: "video/ogg",
	mp3: "audio/mpeg",
	wav: "audio/wav",
	ogg: "audio/ogg",
	opus: "audio/ogg",
	flac: "audio/flac",
	m4a: "audio/mp4",
	aac: "audio/aac",
};

export function attachmentMediaType(name: string): string | null {
	return mediaTypes[name.split(".").at(-1)?.toLowerCase() ?? ""] ?? null;
}

export function attachmentMediaKind(mimeType: string | null): "image" | "video" | "audio" | null {
	if (mimeType?.startsWith("image/")) return "image";
	if (mimeType?.startsWith("video/")) return "video";
	return mimeType?.startsWith("audio/") ? "audio" : null;
}
