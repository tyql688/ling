/** Extensions the app can play or draw, matching the magic numbers `detectPreviewMediaMime` sniffs. */
const IMAGE_EXTENSIONS = new Set(["avif", "bmp", "gif", "jpeg", "jpg", "png", "webp"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "webm"]);

export type PreviewMediaKind = "image" | "video";

/**
 * How a repository path should be previewed, decided from the path alone: the renderer picks a
 * pane before any bytes exist, so it can show the file itself instead of asking for a text diff it
 * could not display. Main still sniffs the bytes before serving them, and a mislabelled extension
 * answers 404 there.
 */
export function previewMediaKind(path: string): PreviewMediaKind | null {
	const name = path.slice(path.lastIndexOf("/") + 1);
	const dot = name.lastIndexOf(".");
	if (dot <= 0) return null;
	const extension = name.slice(dot + 1).toLowerCase();
	if (IMAGE_EXTENSIONS.has(extension)) return "image";
	return VIDEO_EXTENSIONS.has(extension) ? "video" : null;
}
