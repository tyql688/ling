import type { SkinArtworkTreatment } from "@ling/contracts/skins";
import type { CSSProperties } from "react";

type PatternTreatment = Extract<SkinArtworkTreatment, { kind: "paper" | "scanlines" | "linen" }>;

// A seeded, seamless 192px tile is rasterized once by the browser. Neutral grain adds
// tooth in soft light without an animated noise pass or a pale wash across the scene.
const PAPER_GRAIN = `url("data:image/svg+xml,${encodeURIComponent(
	'<svg xmlns="http://www.w3.org/2000/svg" width="192" height="192" viewBox="0 0 192 192"><filter id="grain" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.72" numOctaves="3" seed="17" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/><feComponentTransfer><feFuncR type="linear" slope="3" intercept="-1"/><feFuncG type="linear" slope="3" intercept="-1"/><feFuncB type="linear" slope="3" intercept="-1"/><feFuncA type="discrete" tableValues="1 1"/></feComponentTransfer></filter><path fill="#808080" filter="url(#grain)" d="M0 0h192v192H0z"/></svg>',
)}")`;

// Four CSS-pixel repeats retain distinct scanlines and crossing threads at
// normal display scale. All patterns stay inside the isolated artwork composition.
const PATTERNS: Record<PatternTreatment["kind"], CSSProperties> = {
	paper: { backgroundImage: PAPER_GRAIN, backgroundSize: "192px 192px" },
	scanlines: {
		backgroundImage: "repeating-linear-gradient(0deg, #0000 0 2px, #000b 2px 3px, #fff3 3px 4px)",
	},
	linen: {
		backgroundImage:
			"repeating-linear-gradient(0deg, #0008 0 1px, #fff6 1px 2px, #0000 2px 4px), repeating-linear-gradient(90deg, #0009 0 1px, #fff7 1px 2px, #0000 2px 4px)",
	},
};

/** A single static overlay shared by live artwork and its texture previews. */
export function ArtworkTexture({ treatment }: { treatment: SkinArtworkTreatment }) {
	if (treatment.kind === "glass" || treatment.kind === "dither" || treatment.kind === "clear") return null;
	return (
		<div
			aria-hidden="true"
			className="absolute inset-0"
			style={{ ...PATTERNS[treatment.kind], opacity: treatment.strength, mixBlendMode: "soft-light" }}
		/>
	);
}
