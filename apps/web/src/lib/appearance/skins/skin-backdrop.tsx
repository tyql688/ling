import type { SkinMotion } from "@ling/contracts/skins";
import { useReducedMotion } from "@renderer/hooks/use-reduced-motion";
import { useAppFeedback } from "@renderer/lib/feedback-context";
import { cn } from "@renderer/lib/utils";
import { useContext, useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArtworkTexture } from "./artwork-texture";
import { OrderedDitherFilter } from "./ordered-dither-filter";
import { resolvedArtworkFilter, type ResolvedSkinArtwork } from "./resolve-skin";
import { SkinBackdropContext } from "./skin-backdrop-context";

/** CSS mask-image accepts image paints, so a solid alpha paint needs a constant gradient. */
function alphaMaskImage(paint: string | null | undefined): string | undefined {
	return paint?.startsWith("#") ? `linear-gradient(${paint}, ${paint})` : (paint ?? undefined);
}

function ArtworkScene({
	layer,
	motion,
	preview,
}: {
	layer: ResolvedSkinArtwork;
	motion: SkinMotion;
	preview: boolean;
}) {
	const noMotion = useReducedMotion();
	const filterId = useId();
	const { t } = useTranslation();
	const { show, dismiss } = useAppFeedback();
	const [failedUrl, setFailedUrl] = useState<string | null>(null);
	const playVideo = layer.video && !preview && !noMotion && motion === "ambient";
	const stillUrl = layer.video ? layer.posterUrl : layer.mediaUrl;
	const sourceUrl = playVideo ? layer.mediaUrl : stillUrl;
	const paints = [
		layer.gradient,
		layer.wash,
		layer.mask,
		...layer.layers.flatMap((paint) => [paint.paint, paint.mask]),
	];
	const invalidPaint = paints.find((paint) => paint != null && !CSS.supports("background", paint));
	const invalidPosition = !CSS.supports("background-position", layer.position);
	const failed = failedUrl !== null && failedUrl === sourceUrl;
	useEffect(() => {
		if (!failed && invalidPaint === undefined && !invalidPosition) return;
		const id = show({
			tone: "danger",
			title: t(failed ? "skins.mediaFailed" : "skins.paintFailed"),
			dedupeKey: `skin-artwork:${String(sourceUrl)}`,
		});
		return () => dismiss(id);
	}, [dismiss, failed, invalidPaint, invalidPosition, show, sourceUrl, t]);
	// Two blur radii outside each edge keep source blur from revealing a transparent seam.
	const inset = layer.blur > 0 ? -2 * layer.blur : 0;
	const mediaStyle = {
		position: "absolute" as const,
		inset,
		opacity: layer.opacity,
		filter: resolvedArtworkFilter(layer),
	};
	const mediaGeometry = {
		...mediaStyle,
		// Replaced elements need an explicit box; four radii cover both oversized edges.
		width: layer.blur > 0 ? `calc(100% + ${4 * layer.blur}px)` : "100%",
		height: layer.blur > 0 ? `calc(100% + ${4 * layer.blur}px)` : "100%",
		maxWidth: "none",
		objectFit: layer.fit === "tile" ? ("cover" as const) : layer.fit,
		objectPosition: layer.position,
	};
	return (
		<>
			{layer.treatment.kind === "dither" && <OrderedDitherFilter id={filterId} treatment={layer.treatment} />}
			<div aria-hidden="true" className="absolute inset-0 overflow-hidden" style={{ background: layer.canvas }}>
				<div className="absolute inset-0 isolate" style={{ maskImage: alphaMaskImage(layer.mask), maskMode: "alpha" }}>
					<div
						className="absolute inset-0 overflow-hidden"
						style={{
							background: layer.canvas,
							filter: layer.treatment.kind === "dither" ? `url(#${filterId})` : undefined,
						}}
					>
						{layer.gradient !== null && <div style={{ ...mediaStyle, background: layer.gradient }} />}
						{playVideo && layer.mediaUrl !== null ? (
							<video
								key={layer.mediaUrl}
								src={layer.mediaUrl}
								poster={layer.posterUrl ?? undefined}
								autoPlay
								loop
								muted
								playsInline
								style={mediaGeometry}
								onError={() => setFailedUrl(layer.mediaUrl)}
							/>
						) : (
							stillUrl !== null && (
								<>
									<img
										key={stillUrl}
										src={stillUrl}
										alt=""
										draggable={false}
										style={layer.fit === "tile" ? { position: "absolute", width: 0, height: 0 } : mediaGeometry}
										onError={() => setFailedUrl(stillUrl)}
										onLoad={() => setFailedUrl(null)}
									/>
									{layer.fit === "tile" && (
										<div
											style={{
												...mediaStyle,
												backgroundImage: `url("${stillUrl}")`,
												backgroundRepeat: "repeat",
												backgroundPosition: layer.position,
											}}
										/>
									)}
								</>
							)
						)}
					</div>
					<ArtworkTexture treatment={layer.treatment} />
					{layer.wash !== null && (
						<div className="absolute inset-0" style={{ background: layer.wash, opacity: layer.washOpacity }} />
					)}
					{layer.layers.map((paint) => (
						<div
							key={paint.id}
							className="absolute inset-0"
							style={{
								background: paint.paint,
								opacity: paint.opacity,
								mixBlendMode: paint.blend,
								maskImage: alphaMaskImage(paint.mask),
								maskMode: "alpha",
							}}
						/>
					))}
				</div>
			</div>
			{failed && preview && (
				<span className="absolute inset-0 flex items-center justify-center bg-surface p-2 text-xs text-danger">
					{t("skins.mediaFailed")}
				</span>
			)}
		</>
	);
}

/** A viewport-sized scene shared by the app and gallery; it never participates in scroll layout. */
export function SkinBackdrop({
	layer,
	motion,
	className,
	preview = false,
	tint = false,
}: {
	layer: ResolvedSkinArtwork | null;
	motion: SkinMotion;
	className?: string;
	preview?: boolean;
	tint?: boolean;
}) {
	if (layer === null) return null;
	return (
		<div
			data-skin-scene={layer.scope}
			data-skin-treatment={layer.treatment.kind}
			className={cn("pointer-events-none absolute inset-0 -z-10 overflow-hidden", className)}
		>
			<ArtworkScene layer={layer} motion={motion} preview={preview} />
			{tint && (
				<div
					aria-hidden="true"
					className="absolute inset-0"
					style={{ background: "var(--color-conversation)", backdropFilter: "var(--glass-filter)" }}
				/>
			)}
		</div>
	);
}

/** One conversation scene spans the workbench and its session tabs; reading panes own their backing. */
export function ConversationBackdrop() {
	const { layer, motion } = useContext(SkinBackdropContext);
	return layer?.scope === "conversation" ? <SkinBackdrop layer={layer} motion={motion} tint /> : null;
}
