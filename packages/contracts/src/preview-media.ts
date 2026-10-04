/** Extensions the app can play or draw, matching the magic numbers `detectPreviewMediaMime` sniffs. */
const IMAGE_EXTENSIONS = new Set(["avif", "bmp", "gif", "jpeg", "jpg", "png", "webp"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "webm"]);

export type PreviewMediaKind = "image" | "video";

/** Selects a preview pane from the file path before content loads. Main verifies the file's bytes before serving them and returns 404 for a mismatched extension. */
export function previewMediaKind(path: string): PreviewMediaKind | null {
	const name = path.slice(path.lastIndexOf("/") + 1);
	const dot = name.lastIndexOf(".");
	if (dot <= 0) return null;
	const extension = name.slice(dot + 1).toLowerCase();
	if (IMAGE_EXTENSIONS.has(extension)) return "image";
	return VIDEO_EXTENSIONS.has(extension) ? "video" : null;
}
