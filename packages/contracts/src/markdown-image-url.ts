import type { SessionImageSource } from "./session-messages";
import type { SessionRef } from "./session-ref";

const HOST_MEDIA_PATH = "/api/media";

/** Chromium loads images through authenticated Host routes. Query parameters carry the original path for Host validation. */
export function markdownImageUrl(cwd: string, path: string): string {
	return `${HOST_MEDIA_PATH}/project?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}`;
}

export function parseMarkdownImageUrl(url: string): { cwd: string; path: string } | null {
	const parsed = new URL(url, "http://ling.local");
	const cwd = parsed.searchParams.get("cwd");
	const path = parsed.searchParams.get("path");
	return cwd === null || path === null ? null : { cwd, path };
}

/** Select the authenticated media route; each kind validates its own source. */
export function markdownImageUrlKind(url: string): "project" | "attachment" | "review" | null {
	try {
		const parsed = new URL(url, "http://ling.local");
		const kind = parsed.pathname.startsWith(`${HOST_MEDIA_PATH}/`)
			? parsed.pathname.slice(HOST_MEDIA_PATH.length + 1)
			: "";
		return kind === "project" || kind === "attachment" || kind === "review" ? kind : null;
	} catch {
		return null;
	}
}

type ReviewMediaSide = "base" | "current";

/** Authenticated route for either side of a changed media file, including video. Transcript image routes support drawable image formats. */
export function reviewMediaUrl(cwd: string, path: string, side: ReviewMediaSide, revision?: string): string {
	const query = new URLSearchParams({ cwd, path, side });
	if (revision !== undefined) query.set("revision", revision);
	return `${HOST_MEDIA_PATH}/review?${query.toString()}`;
}

export function parseReviewMediaUrl(
	url: string,
): { cwd: string; path: string; side: ReviewMediaSide; revision?: string } | null {
	const parsed = new URL(url, "http://ling.local");
	const cwd = parsed.searchParams.get("cwd");
	const path = parsed.searchParams.get("path");
	const side = parsed.searchParams.get("side");
	const revision = parsed.searchParams.get("revision");
	if (cwd === null || path === null) return null;
	return side === "base" || side === "current" ? { cwd, path, side, ...(revision === null ? {} : { revision }) } : null;
}

export function sessionImageUrl(ref: SessionRef, source: SessionImageSource): string {
	const query = new URLSearchParams({
		cwd: ref.cwd,
		session: ref.sessionId,
		entry: source.entryId,
		index: String(source.index),
	});
	return `${HOST_MEDIA_PATH}/attachment?${query.toString()}`;
}

export function parseSessionImageUrl(url: string): { ref: SessionRef; source: SessionImageSource } | null {
	const parsed = new URL(url, "http://ling.local");
	const cwd = parsed.searchParams.get("cwd");
	const sessionId = parsed.searchParams.get("session");
	const entryId = parsed.searchParams.get("entry");
	const index = Number(parsed.searchParams.get("index"));
	if (cwd === null || sessionId === null || entryId === null) return null;
	if (!Number.isSafeInteger(index) || index < 0) return null;
	return { ref: { cwd, sessionId }, source: { entryId, index } };
}
