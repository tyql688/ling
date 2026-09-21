import { getContrast } from "color2k";
import { SKIN_FOREGROUND_CONTRAST_MIN } from "@ling/contracts/skins";

/** Hex channels contain two base-16 digits. */
const HEX_RADIX = 16;
/** RGB channels are eight-bit values. */
const CHANNEL_MAX = 255;

function channel(color: string, index: number): number {
	return Number.parseInt(color.slice(1 + index * 2, 3 + index * 2), HEX_RADIX);
}

export function mixSkinColor(from: string, to: string, amount: number): string {
	const mixed = (index: number) =>
		Math.round(channel(from, index) + (channel(to, index) - channel(from, index)) * amount)
			.toString(HEX_RADIX)
			.padStart(2, "0");
	return `#${mixed(0)}${mixed(1)}${mixed(2)}`;
}

export function skinColorWithAlpha(color: string, amount: number): string {
	const encoded = Math.round(CHANNEL_MAX * amount)
		.toString(HEX_RADIX)
		.padStart(2, "0");
	return `${color}${encoded}`;
}

/** Preserve the intended tint, moving only as far toward a validated foreground as AA requires. */
export function readableSkinColor(candidate: string, surfaces: readonly string[], foreground: string): string {
	const readable = (color: string) =>
		surfaces.every((surface) => getContrast(color, surface) >= SKIN_FOREGROUND_CONTRAST_MIN);
	if (readable(candidate)) return candidate;
	if (!readable(foreground)) throw new Error("Skin surfaces have no shared readable foreground");
	let low = 0;
	let high = 1;
	// Twelve bisections resolve a blend more finely than an 8-bit color channel.
	for (let step = 0; step < 12; step += 1) {
		const amount = (low + high) / 2;
		if (readable(mixSkinColor(candidate, foreground, amount))) high = amount;
		else low = amount;
	}
	return mixSkinColor(candidate, foreground, high);
}
