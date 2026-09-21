import { markdownImageUrl } from "@ling/contracts/markdown-image-url";
import { ImagePreviewDialog, type PreviewImage } from "@renderer/components/image-preview-dialog";
import { MarkdownImageRootContext, MarkdownDocumentContext } from "@renderer/components/markdown-image-root";
import { isWindows } from "@renderer/lib/platform";
import { ImageOff } from "lucide-react";
import { type ComponentProps, useContext, useState } from "react";
import { useTranslation } from "react-i18next";

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

/**
 * Markdown images resolve workspace paths through the authenticated Host route.
 * Anything with no loader renders as its alt text instead of a broken-image glyph.
 */
export function MarkdownImage({ src, alt, ...rest }: ComponentProps<"img">) {
	const { t } = useTranslation();
	const root = useContext(MarkdownImageRootContext);
	const document = useContext(MarkdownDocumentContext);
	const [preview, setPreview] = useState<PreviewImage | null>(null);
	// Keyed by URL, not a bare flag: a streamed message rewrites this slot's src as it grows,
	// and a failure recorded for the half-written path must not condemn the finished one.
	const [failedUrl, setFailedUrl] = useState<string | null>(null);
	const source = typeof src === "string" ? src : null;
	// Document resolution already decodes and validates the URL. Passing its literal path
	// through the URL decoder again would change filenames such as image%20one.png.
	const documentPath =
		source !== null && document && !source.startsWith(HTTPS_URL_PREFIX) && !source.startsWith(DATA_IMAGE_PREFIX)
			? document.resolve(source)
			: undefined;
	const url =
		documentPath === undefined
			? resolveImageUrl(source, root)
			: documentPath !== null && root !== null
				? markdownImageUrl(root, documentPath)
				: null;
	const label = alt !== undefined && alt.length > 0 ? alt : t("markdown.imageNotAvailable");

	if (url === null || url === failedUrl) {
		return (
			<span className="md-image-missing" title={source ?? undefined}>
				<ImageOff className="size-3.5 shrink-0" aria-hidden="true" />
				{label}
			</span>
		);
	}

	return (
		<>
			<ImagePreviewDialog image={preview} onClose={() => setPreview(null)} />
			<button
				type="button"
				className="md-image-button"
				aria-label={t("session.imagePreview")}
				onClick={() => setPreview({ src: url, alt: label })}
			>
				<img {...rest} src={url} alt={alt ?? ""} loading="lazy" onError={() => setFailedUrl(url)} />
			</button>
		</>
	);
}
