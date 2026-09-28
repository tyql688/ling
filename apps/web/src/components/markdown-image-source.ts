import { markdownImageUrl } from "@ling/contracts/markdown-image-url";
import { MarkdownImageRootContext, MarkdownDocumentContext } from "@renderer/components/markdown-image-root";
import { isWindows } from "@renderer/lib/platform";
import { useCallback, useContext } from "react";

const FILE_URL_PREFIX = "file://";
/** The two source kinds the CSP's img-src can load directly; http is deliberately absent. */
const HTTPS_URL_PREFIX = "https://";
const DATA_IMAGE_PREFIX = "data:image/";
/** Any scheme but a Windows drive letter, which needs two or more characters to match. */
const URL_SCHEME = /^[A-Za-z][A-Za-z\d+.-]+:/;
/** Windows drive-letter roots; POSIX absolute paths start with a separator instead. */
const WINDOWS_ABSOLUTE = /^[A-Za-z]:[/\\]/;
const WINDOWS_DRIVE_ROOT = /^[A-Za-z]:\/$/;

function isAbsolutePath(value: string): boolean {
	return value.startsWith("/") || (isWindows && (value.startsWith("\\") || WINDOWS_ABSOLUTE.test(value)));
}

/** Markdown URLs are percent-encoded by spec, so `docs/my%20shot.png` names a file with a
 * space in it. A `%` that is not a valid escape means the author wrote a literal path
 * instead — that is a parse outcome, not a failed decode, so keep the string as written. */
function decodePath(value: string): string {
	if (!value.includes("%")) return value;
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

function insideRoot(absolute: string, root: string): string | null {
	const normalizedAbsolute = isWindows ? absolute.replaceAll("\\", "/") : absolute;
	const separatedRoot = isWindows ? root.replaceAll("\\", "/") : root;
	const normalizedRoot =
		separatedRoot === "/" || WINDOWS_DRIVE_ROOT.test(separatedRoot) ? separatedRoot : separatedRoot.replace(/\/+$/, "");
	const comparedAbsolute = isWindows ? normalizedAbsolute.toLowerCase() : normalizedAbsolute;
	const comparedRoot = isWindows ? normalizedRoot.toLowerCase() : normalizedRoot;
	if (!comparedAbsolute.startsWith(comparedRoot)) return null;
	if (normalizedRoot.endsWith("/")) {
		const relative = normalizedAbsolute.slice(normalizedRoot.length);
		return relative.length > 0 ? relative : null;
	}
	// The separator boundary stops /work/proj-old from reading as a child of /work/proj.
	const boundary = normalizedAbsolute.charCodeAt(normalizedRoot.length);
	return boundary === 47 ? normalizedAbsolute.slice(normalizedRoot.length + 1) : null;
}

/**
 * Project-relative path for a markdown image source, or null when the file sits outside the
 * session's workspace. Both the renderer and the Host media handler enforce that bound.
 */
function projectRelativeImagePath(src: string, root: string): string | null {
	const decoded = decodePath(src.startsWith(FILE_URL_PREFIX) ? src.slice(FILE_URL_PREFIX.length) : src);
	// `file:///C:/dir/a.png` keeps a leading slash ahead of the drive letter.
	const path =
		isWindows && decoded.startsWith("/") && WINDOWS_ABSOLUTE.test(decoded.slice(1)) ? decoded.slice(1) : decoded;
	const relative = isAbsolutePath(path) ? insideRoot(path, root) : path.replace(/^\.\//, "");
	if (relative === null || relative.includes("\0")) return null;
	const segments = isWindows ? relative.split(/[/\\]/) : relative.split("/");
	// Empty and dot segments either escape the workspace or fail the main-side path bounds.
	if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) return null;
	return segments.join("/");
}

/**
 * What the browser should load for this source, or null when Ling has nothing to serve — a
 * scheme the CSP refuses, or a file outside the workspace. Remote https images load straight
 * from their origin, which also means viewing the message tells that host it was viewed.
 */
function resolveImageUrl(source: string | null, root: string | null): string | null {
	if (source === null) return null;
	if (source.startsWith(HTTPS_URL_PREFIX) || source.startsWith(DATA_IMAGE_PREFIX)) return source;
	// Everything else carrying a scheme is a URL with no loader here, and must not be mistaken
	// for a workspace path — `data:text/html,a/b` otherwise reads as a plausible relative path.
	if (URL_SCHEME.test(source) && !source.startsWith(FILE_URL_PREFIX)) return null;
	if (root === null) return null;
	const path = projectRelativeImagePath(source, root);
	return path === null ? null : markdownImageUrl(root, path);
}

/** HTML and Markdown images share document-relative resolution and the authenticated route. */
export function useMarkdownImageUrl() {
	const root = useContext(MarkdownImageRootContext);
	const document = useContext(MarkdownDocumentContext);
	return useCallback(
		(source: string | null) => {
			// Document resolution already decodes the URL; decoding again would change literal percent filenames.
			const path =
				source !== null && document && !source.startsWith(HTTPS_URL_PREFIX) && !source.startsWith(DATA_IMAGE_PREFIX)
					? document.resolve(source)
					: undefined;
			return path === undefined
				? resolveImageUrl(source, root)
				: path !== null && root !== null
					? markdownImageUrl(root, path)
					: null;
		},
		[root, document],
	);
}
