import { markdownImageUrl } from "@ling/contracts/markdown-image-url";
import { MarkdownImageRootContext, MarkdownDocumentContext } from "@renderer/components/markdown-image-root";
import { isWindows } from "@renderer/lib/platform";
import { useCallback, useContext } from "react";

const FILE_URL_PREFIX = "file://";
/** Source schemes allowed by CSP for direct image loading. */
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

/** Decodes percent-encoded Markdown URLs, such as `docs/my%20shot.png`. An invalid escape denotes a literal path, which is returned unchanged. */
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

/** Returns an image URL, or null for a scheme blocked by CSP or a file outside the workspace. Remote HTTPS images load from their origin, so that server receives the image request when the message is viewed. */
function resolveImageUrl(source: string | null, root: string | null): string | null {
	if (source === null) return null;
	if (source.startsWith(HTTPS_URL_PREFIX) || source.startsWith(DATA_IMAGE_PREFIX)) return source;
	// Reject unsupported schemes before resolving workspace paths; `data:text/html,a/b` otherwise resembles a relative path.

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
