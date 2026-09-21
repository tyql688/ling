import { Dialog, DialogContent, DialogTitle } from "@renderer/components/ui/dialog";
import { cn } from "@renderer/lib/utils";
import { X } from "lucide-react";
import { motion } from "motion/react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

export interface PreviewImage {
	src: string;
	alt?: string;
}

/** Double-click zoom factor; large enough to inspect text in screenshots, small enough to stay orientable. */
const ZOOM_SCALE = 2.5;

/** Keyed by src from the dialog, so a new image (or a reopen) always starts at fit-to-viewport. */
function ZoomableImage({ image }: { image: PreviewImage }) {
	const [zoomed, setZoomed] = useState(false);
	return (
		<motion.img
			src={image.src}
			alt={image.alt ?? ""}
			drag={zoomed}
			dragMomentum={false}
			onDoubleClick={() => setZoomed((current) => !current)}
			animate={zoomed ? { scale: ZOOM_SCALE } : { scale: 1, x: 0, y: 0 }}
			transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
			className={cn(
				"max-h-[86vh] max-w-[92vw] rounded-panel bg-popover object-contain shadow-2xl",
				zoomed ? "cursor-grab active:cursor-grabbing" : "cursor-zoom-in",
			)}
		/>
	);
}

export function ImagePreviewDialog({ image, onClose }: { image: PreviewImage | null; onClose: () => void }) {
	const { t } = useTranslation();
	return (
		<Dialog open={image !== null} onOpenChange={(next) => !next && onClose()}>
			<DialogContent size="viewport" className="w-auto border-none bg-transparent p-0 shadow-none ring-0">
				<DialogTitle className="sr-only">{t("session.imagePreview")}</DialogTitle>
				<button
					type="button"
					className="absolute -top-3 -right-3 z-10 flex size-7 items-center justify-center rounded-full border border-border-subtle bg-surface text-text-muted shadow-md transition-colors hover:bg-surface-hover hover:text-text-primary"
					onClick={onClose}
					aria-label={t("markdown.close")}
				>
					<X className="size-4" aria-hidden="true" />
				</button>
				{image && <ZoomableImage key={image.src} image={image} />}
			</DialogContent>
		</Dialog>
	);
}
