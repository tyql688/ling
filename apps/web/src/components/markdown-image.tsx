import { ImagePreviewDialog, type PreviewImage } from "@renderer/components/image-preview-dialog";
import { useMarkdownImageUrl } from "@renderer/components/markdown-image-source";
import { ImageOff } from "lucide-react";
import { type ComponentProps, useState } from "react";
import { useTranslation } from "react-i18next";

/**
 * Markdown images resolve workspace paths through the authenticated Host route.
 * Anything with no loader renders as its alt text instead of a broken-image glyph.
 */
export function MarkdownImage({ src, alt, ...rest }: ComponentProps<"img">) {
	const { t } = useTranslation();
	const resolveUrl = useMarkdownImageUrl();
	const [preview, setPreview] = useState<PreviewImage | null>(null);
	// Keyed by URL, not a bare flag: a streamed message rewrites this slot's src as it grows,
	// and a failure recorded for the half-written path must not condemn the finished one.
	const [failedUrl, setFailedUrl] = useState<string | null>(null);
	const source = typeof src === "string" ? src : null;
	const url = resolveUrl(source);
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
