import type { SessionRuntimeCommands } from "@ling/host/domains/sessions/manager/session-runtime-commands";
import { GIT_COMMIT_SHA_PATTERN } from "@ling/contracts/git";
import { ABSOLUTE_PATH_MAX_CHARS } from "@ling/contracts/path-bounds";
import { PROJECT_RELATIVE_PATH_MAX_CHARS } from "@ling/contracts/project";
import {
	isSkinAssetPath,
	isSkinVideoAsset,
	SKIN_ID_PATTERN,
	SKIN_MEDIA_IMAGE_MAX_BYTES,
	SKIN_MEDIA_VIDEO_MAX_BYTES,
} from "@ling/contracts/skins";
import {
	markdownImageUrlKind,
	parseMarkdownImageUrl,
	parseReviewMediaUrl,
	parseSessionImageUrl,
} from "@ling/contracts/markdown-image-url";
import { previewMediaKind } from "@ling/contracts/preview-media";
import { readGitBlobAtCommit, readGitBlobAtHead } from "@ling/host/domains/git/git-service";
import { createLogger } from "@ling/core/logger";
import {
	detectPreviewMediaMime,
	readProjectFilePreview,
	resolveWorkspaceMediaFile,
} from "@ling/host/domains/files/project-files";
import type { ProjectAccess } from "@ling/host/runtime/project-access";
import { createReadStream } from "node:fs";
import { stat, type FileHandle } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { openExistingSkinAsset } from "../domains/skins/skin-package-store";

import type { HostMediaResponder } from "../transport/web-server";

const log = createLogger("host-media");
/** Session and entry ids share the projection bound used by persisted attachment references. */
const ATTACHMENT_ID_MAX_CHARS = 512;
/** Review media is intentionally smaller than skin video: diffs travel from Git or a working tree. */
const REVIEW_MEDIA_MAX_BYTES = 16 * 1_024 * 1_024;

const MEDIA_MIME: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	webp: "image/webp",
	avif: "image/avif",
	mp4: "video/mp4",
	webm: "video/webm",
};

function missingFile(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function writeBytes(response: ServerResponse, bytes: Uint8Array, mime: string, cacheControl: string): void {
	response.writeHead(200, {
		"Cache-Control": cacheControl,
		"Content-Length": bytes.byteLength,
		"Content-Type": mime,
		"X-Content-Type-Options": "nosniff",
	});
	response.end(bytes);
}

function parseRange(value: string | undefined, size: number): { start: number; end: number } | null {
	if (value === undefined) return null;
	const match = /^bytes=(\d+)-(\d*)$/.exec(value);
	if (!match) return null;
	const start = Number(match[1]);
	const end = match[2] === "" ? size - 1 : Number(match[2]);
	if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || end >= size)
		return null;
	return { start, end };
}

function streamFile(
	request: IncomingMessage,
	response: ServerResponse,
	source: string | FileHandle,
	size: number,
	mime: string,
): Promise<void> {
	if (size === 0) {
		response.writeHead(404).end();
		return Promise.resolve();
	}
	const range = parseRange(request.headers.range, size);
	const start = range?.start ?? 0;
	const end = range?.end ?? size - 1;
	response.writeHead(range ? 206 : 200, {
		"Accept-Ranges": "bytes",
		"Cache-Control": "no-cache",
		"Content-Length": end - start + 1,
		"Content-Type": mime,
		...(range ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
		"X-Content-Type-Options": "nosniff",
	});
	if (request.method === "HEAD") {
		response.end();
		return Promise.resolve();
	}
	return new Promise<void>((resolve, reject) => {
		const stream =
			typeof source === "string"
				? createReadStream(source, { start, end })
				: source.createReadStream({ start, end, autoClose: false });
		stream.once("error", reject);
		response.once("close", () => {
			stream.destroy();
			resolve();
		});
		stream.pipe(response);
	});
}

export function createHostMediaResponder(
	projectsRestored: Promise<void>,
	{
		projectOperations,
		readSessionImage,
	}: { projectOperations: ProjectAccess; readSessionImage: SessionRuntimeCommands["readSessionImage"] },
): HostMediaResponder {
	const { withKnownOpenProject } = projectOperations;

	return async (request, response) => {
		if (request.method !== "GET" && request.method !== "HEAD") {
			response.writeHead(405, { Allow: "GET, HEAD" }).end();
			return;
		}
		await projectsRestored;
		const requestUrl = request.url ?? "";
		try {
			const parsedUrl = new URL(requestUrl, "http://ling.local");
			if (parsedUrl.pathname === "/api/media/skin") {
				await serveSkinMedia(request, response, parsedUrl);
				return;
			}
			const kind = markdownImageUrlKind(requestUrl);
			if (kind === "attachment") {
				await serveSessionImage(response, requestUrl, readSessionImage);
				return;
			}
			if (kind === "review") {
				await serveReviewMedia(request, response, requestUrl, withKnownOpenProject);
				return;
			}
			if (kind === "project") {
				await serveProjectImage(response, requestUrl, withKnownOpenProject);
				return;
			}
			response.writeHead(404).end();
		} catch (error) {
			log.warn("could not serve host media request:", error);
			if (!response.headersSent) response.writeHead(500);
			response.end();
		}
	};
}

async function serveSkinMedia(request: IncomingMessage, response: ServerResponse, parsedUrl: URL): Promise<void> {
	const id = parsedUrl.searchParams.get("id");
	const asset = parsedUrl.searchParams.get("asset");
	if (id === null || asset === null || !SKIN_ID_PATTERN.test(id) || !isSkinAssetPath(asset)) {
		response.writeHead(400).end();
		return;
	}
	let handle: FileHandle;
	try {
		handle = await openExistingSkinAsset(id, asset);
	} catch (error) {
		if (missingFile(error)) {
			response.writeHead(404).end();
			return;
		}
		throw error;
	}
	try {
		const info = await handle.stat();
		const maxBytes = isSkinVideoAsset(asset) ? SKIN_MEDIA_VIDEO_MAX_BYTES : SKIN_MEDIA_IMAGE_MAX_BYTES;
		if (!info.isFile() || info.size === 0 || info.size > maxBytes) {
			response.writeHead(404).end();
			return;
		}
		const extension = asset.split(".").pop()?.toLowerCase() ?? "";
		await streamFile(request, response, handle, info.size, MEDIA_MIME[extension] ?? "application/octet-stream");
	} finally {
		await handle.close();
	}
	return;
}

async function serveSessionImage(
	response: ServerResponse,
	requestUrl: string,
	readSessionImage: SessionRuntimeCommands["readSessionImage"],
): Promise<void> {
	const target = parseSessionImageUrl(requestUrl);
	if (
		target === null ||
		target.ref.cwd.length > ABSOLUTE_PATH_MAX_CHARS ||
		target.ref.sessionId.length > ATTACHMENT_ID_MAX_CHARS ||
		target.source.entryId.length > ATTACHMENT_ID_MAX_CHARS
	) {
		response.writeHead(400).end();
		return;
	}
	const image = await readSessionImage(target.ref, target.source);
	if (image === null) response.writeHead(404).end();
	else writeBytes(response, Buffer.from(image.data, "base64"), image.mimeType, "public, max-age=31536000, immutable");
	return;
}

async function serveReviewMedia(
	request: IncomingMessage,
	response: ServerResponse,
	requestUrl: string,
	withKnownOpenProject: ProjectAccess["withKnownOpenProject"],
): Promise<void> {
	const target = parseReviewMediaUrl(requestUrl);
	if (
		target === null ||
		target.cwd.length > ABSOLUTE_PATH_MAX_CHARS ||
		target.path.length > PROJECT_RELATIVE_PATH_MAX_CHARS ||
		(target.revision !== undefined && !GIT_COMMIT_SHA_PATTERN.test(target.revision)) ||
		previewMediaKind(target.path) === null
	) {
		response.writeHead(400).end();
		return;
	}
	if (target.revision === undefined && target.side === "current") {
		const resolved = await withKnownOpenProject(target.cwd, (cwd) =>
			resolveWorkspaceMediaFile(cwd, target.path, REVIEW_MEDIA_MAX_BYTES).catch((error: unknown) => {
				if (missingFile(error)) return null;
				throw error;
			}),
		);
		if (resolved === null) response.writeHead(404).end();
		else {
			const info = await stat(resolved.filePath);
			await streamFile(request, response, resolved.filePath, info.size, resolved.mime);
		}
		return;
	}
	const media = await withKnownOpenProject(target.cwd, async (cwd) => {
		const blob =
			target.revision === undefined
				? await readGitBlobAtHead(cwd, target.path)
				: await readGitBlobAtCommit(cwd, target.revision, target.path);
		if (blob === null || blob.byteLength === 0) return null;
		const mime = detectPreviewMediaMime(blob);
		return mime === null ? null : { data: new Uint8Array(blob), mime };
	});
	if (media === null) response.writeHead(404).end();
	else writeBytes(response, media.data, media.mime, "no-cache");
	return;
}

async function serveProjectImage(
	response: ServerResponse,
	requestUrl: string,
	withKnownOpenProject: ProjectAccess["withKnownOpenProject"],
): Promise<void> {
	const target = parseMarkdownImageUrl(requestUrl);
	if (
		target === null ||
		target.cwd.length > ABSOLUTE_PATH_MAX_CHARS ||
		target.path.length > PROJECT_RELATIVE_PATH_MAX_CHARS
	) {
		response.writeHead(400).end();
		return;
	}
	const preview = await withKnownOpenProject(target.cwd, (cwd) => readProjectFilePreview(cwd, target.path)).catch(
		(error: unknown) => {
			if (missingFile(error)) return null;
			throw error;
		},
	);
	if (preview === null || preview.kind !== "image") response.writeHead(404).end();
	else writeBytes(response, preview.data, preview.mime, "no-cache");
	return;
}
