import type { SkinArtworkTreatment } from "@ling/contracts/skins";

/** A 4 by 4 Bayer tile distributes thresholds evenly without random or animated noise. */
const BAYER_SIDE = 4;
const BAYER_THRESHOLDS = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const THRESHOLD_TILE = `data:image/svg+xml,${encodeURIComponent(
	`<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4" viewBox="0 0 4 4" shape-rendering="crispEdges">${BAYER_THRESHOLDS.map(
		(threshold, index) => {
			// Mid-bin thresholds preserve the average tone; SVG percentages avoid 8-bit rounding bias.
			const gray = ((threshold + 0.5) / BAYER_THRESHOLDS.length) * 100;
			return `<rect x="${String(index % BAYER_SIDE)}" y="${String(Math.floor(index / BAYER_SIDE))}" width="1" height="1" fill="rgb(${String(gray)}% ${String(gray)}% ${String(gray)}%)"/>`;
		},
	).join("")}</svg>`,
)}`;

/** Quantizes scene pixels, including gradients and video, in one static browser filter graph. */
export function OrderedDitherFilter({
	id,
	treatment,
}: {
	id: string;
	treatment: Extract<SkinArtworkTreatment, { kind: "dither" }>;
}) {
	const { levels, strength, cellSize } = treatment;
	// N intervals have N+1 output tones. This arithmetic makes the transfer compute
	// floor(source * N + threshold) / N, so dot density follows source luminance.
	const tones = Array.from({ length: levels + 1 }, (_, index) => index / levels).join(" ");
	return (
		<svg aria-hidden="true" width="0" height="0" className="absolute">
			<defs>
				<filter id={id} x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB">
					<feImage
						href={THRESHOLD_TILE}
						x="0"
						y="0"
						width={cellSize * BAYER_SIDE}
						height={cellSize * BAYER_SIDE}
						result="tile"
					/>
					<feTile in="tile" result="threshold" />
					<feComposite
						in="SourceGraphic"
						in2="threshold"
						operator="arithmetic"
						k2={levels / (levels + 1)}
						k3={1 / (levels + 1)}
						result="offset"
					/>
					<feComponentTransfer in="offset" result="quantized">
						<feFuncR type="discrete" tableValues={tones} />
						<feFuncG type="discrete" tableValues={tones} />
						<feFuncB type="discrete" tableValues={tones} />
					</feComponentTransfer>
					<feComposite
						in="quantized"
						in2="SourceGraphic"
						operator="arithmetic"
						k2={strength}
						k3={1 - strength}
						result="blended"
					/>
					{/* The threshold image has its own alpha. Clip it back to the source so hidden
					    galleries and transparent edges cannot paint a residual Bayer rectangle. */}
					<feComposite in="blended" in2="SourceGraphic" operator="in" />
				</filter>
			</defs>
		</svg>
	);
}
