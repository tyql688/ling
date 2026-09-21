import { getContrast } from "color2k";
import { z } from "zod";
import { hasControlCharacter } from "./text-validation";

/** Version 3 distinguishes a fixed artwork design from a studio's light/dark pair. */
export const SKIN_SCHEMA_VERSION = 3;
export const SKIN_MANIFEST_FILE = "skin.json";

/** A stable id is also a directory name and preference value. */
export const SKIN_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
/** A manifest is declarative metadata, so 128 KiB leaves ample room while rejecting accidental dumps. */
export const SKIN_MANIFEST_MAX_BYTES = 128 * 1024;
/** One hundred packages keeps discovery bounded even when a generator runs away. */
export const SKIN_PACKAGE_MAX_COUNT = 100;
/** Artwork images above 32 MiB are inappropriate for a window background. */
export const SKIN_MEDIA_IMAGE_MAX_BYTES = 32 * 1024 * 1024;
/** Ambient video has a higher ceiling but still cannot become an unbounded local media route. */
export const SKIN_MEDIA_VIDEO_MAX_BYTES = 256 * 1024 * 1024;

/** Metadata bounds keep gallery rows and diagnostics predictable. */
const SKIN_NAME_MAX_CHARS = 100;
const SKIN_DESCRIPTION_MAX_CHARS = 300;
const SKIN_AUTHOR_MAX_CHARS = 100;
const SKIN_LICENSE_MAX_CHARS = 120;
/** Relative package paths include `assets/`, optional subdirectories, and a file name. */
const SKIN_ASSET_PATH_MAX_CHARS = 240;
/** A package may nest assets three levels below `assets/`; deeper trees add no skin capability. */
const SKIN_ASSET_MAX_SEGMENTS = 5;
/** CSS paint strings are bounded because they are data, never an injected stylesheet. */
const SKIN_PAINT_MAX_CHARS = 2_000;
/** Backdrop blur beyond 64 px is visually indistinguishable while increasing compositor cost. */
const SKIN_ARTWORK_BLUR_MAX_PX = 64;
/** Two times the source value covers strong mode retuning without allowing pathological filters. */
const SKIN_ARTWORK_TONE_MAX = 2;

const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const HEX_PAINT_PATTERN = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i;
const GRADIENT_PATTERN = /^(?:repeating-)?(?:linear|radial|conic)-gradient\(/i;
const UNSAFE_PAINT_PATTERN = /(?:url|var|image-set|cross-fade|element|attr)\s*\(|[;{}\\]/i;
const POSITION_PATTERN = /^[a-z0-9% .-]{1,64}$/i;
const ASSET_SEGMENT_PATTERN = /^[A-Za-z0-9_@-][A-Za-z0-9_.@ -]{0,63}$/;
const IMAGE_EXTENSION_PATTERN = /\.(?:png|jpe?g|webp|avif)$/i;
const MEDIA_EXTENSION_PATTERN = /\.(?:png|jpe?g|webp|avif|mp4|webm)$/i;
const VIDEO_EXTENSION_PATTERN = /\.(?:mp4|webm)$/i;
/** WCAG AA minimum for every palette color that Ling uses as normal-sized foreground text. */
export const SKIN_FOREGROUND_CONTRAST_MIN = 4.5;

function boundedText(maxChars: number) {
	return z
		.string()
		.trim()
		.min(1)
		.max(maxChars)
		.refine((value) => !hasControlCharacter(value), "must not contain control characters");
}

function safePaint(value: string): boolean {
	let depth = 0;
	for (const character of value) {
		if (character === "(") depth += 1;
		if (character === ")") depth -= 1;
		if (depth < 0) return false;
	}
	const completeGradient = GRADIENT_PATTERN.test(value) && value.endsWith(")") && depth === 0;
	return (
		value.length <= SKIN_PAINT_MAX_CHARS &&
		!hasControlCharacter(value) &&
		!UNSAFE_PAINT_PATTERN.test(value) &&
		(HEX_PAINT_PATTERN.test(value) || completeGradient)
	);
}

export function isSkinAssetPath(value: string, imageOnly = false): boolean {
	if (value.length === 0 || value.length > SKIN_ASSET_PATH_MAX_CHARS || value.includes("\\")) return false;
	const segments = value.split("/");
	if (segments.length < 2 || segments.length > SKIN_ASSET_MAX_SEGMENTS || segments[0] !== "assets") return false;
	if (segments.slice(1).some((segment) => !ASSET_SEGMENT_PATTERN.test(segment))) return false;
	return (imageOnly ? IMAGE_EXTENSION_PATTERN : MEDIA_EXTENSION_PATTERN).test(value);
}

export function isSkinVideoAsset(value: string): boolean {
	return VIDEO_EXTENSION_PATTERN.test(value);
}

const skinColorSchema = z.string().regex(HEX_COLOR_PATTERN, { message: "must be a six-digit hex color", abort: true });
const skinAssetSchema = z.string().refine((value) => isSkinAssetPath(value), "must be a safe path below assets/");
const skinImageAssetSchema = z
	.string()
	.refine((value) => isSkinAssetPath(value, true), "must be a safe image path below assets/");
const skinPaintSchema = z.string().refine(safePaint, "must be a bounded hex color or CSS gradient");

const skinPaletteSchema = z.strictObject({
	canvas: skinColorSchema,
	surface: skinColorSchema,
	text: skinColorSchema,
	accent: skinColorSchema,
	secondary: skinColorSchema,
});

export type SkinPalette = z.infer<typeof skinPaletteSchema>;

export const skinArtworkScopeSchema = z.enum(["window", "conversation"]);
export type SkinArtworkScope = z.infer<typeof skinArtworkScopeSchema>;

/** A bounded filter graph keeps the scene independent of transcript length. */
const currentSkinArtworkTreatmentSchema = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("glass"), blur: z.number().min(0).max(SKIN_ARTWORK_BLUR_MAX_PX).optional() }),
	z.strictObject({
		kind: z.literal("dither"),
		/** CSS pixels per Bayer cell: below one aliases; above six obscures small artwork details. */
		cellSize: z.number().min(1).max(6),
		/** Quantization intervals per RGB channel; two through sixteen span print-like to fine texture. */
		levels: z.number().int().min(2).max(16),
		strength: z.number().min(0).max(1),
	}),
	z.strictObject({ kind: z.literal("clear") }),
	z.strictObject({
		kind: z.enum(["paper", "scanlines", "linen"]),
		/** Static texture opacity; zero preserves the source and one uses the full pattern. */
		strength: z.number().min(0).max(1),
	}),
]);

/** Fine cells and four intervals preserve recognizable color in the default pixel effect. */
export const DEFAULT_SKIN_DITHER_TREATMENT = {
	kind: "dither",
	cellSize: 1.5,
	levels: 4,
	strength: 1,
} as const satisfies z.infer<typeof currentSkinArtworkTreatmentSchema>;

/** Retired print dots become pixel dithering without invalidating saved choices or authored skins. */
export const skinArtworkTreatmentSchema = z
	.union([
		currentSkinArtworkTreatmentSchema,
		z
			.strictObject({ kind: z.literal("halftone"), strength: z.number().min(0).max(1) })
			.transform(({ strength }) => ({ ...DEFAULT_SKIN_DITHER_TREATMENT, strength })),
	])
	.pipe(currentSkinArtworkTreatmentSchema);
export type SkinArtworkTreatment = z.infer<typeof skinArtworkTreatmentSchema>;

const skinPaintLayerSchema = z.strictObject({
	id: z.string().regex(SKIN_ID_PATTERN, "must be a stable lowercase kebab-case layer id"),
	paint: skinPaintSchema,
	opacity: z.number().min(0).max(1),
	blend: z.enum(["normal", "multiply", "screen", "overlay", "soft-light", "color", "luminosity"]),
	/** Alpha mask for this paint only; omitted masks leave the entire layer visible. */
	mask: skinPaintSchema.optional(),
});

const skinArtworkSchema = z
	.strictObject({
		/** Existing packages keep their whole-window glass until an author or user chooses otherwise. */
		scope: skinArtworkScopeSchema.optional(),
		treatment: skinArtworkTreatmentSchema.optional(),
		/** Eight ordered paint layers allow authored compositions without an unbounded compositor graph. */
		layers: z
			.array(skinPaintLayerSchema)
			.max(8)
			.refine(
				(layers) => new Set(layers.map((layer) => layer.id)).size === layers.length,
				"paint layer ids must be unique",
			)
			.optional(),
		/** Alpha mask for media, treatment, and paint layers together, revealing the palette canvas. */
		mask: skinPaintSchema.optional(),
		media: skinAssetSchema.nullable(),
		poster: skinImageAssetSchema.nullable(),
		gradient: skinPaintSchema.nullable(),
		opacity: z.number().min(0).max(1),
		brightness: z.number().min(0).max(SKIN_ARTWORK_TONE_MAX),
		contrast: z.number().min(0).max(SKIN_ARTWORK_TONE_MAX),
		saturation: z.number().min(0).max(SKIN_ARTWORK_TONE_MAX),
		blur: z.number().min(0).max(SKIN_ARTWORK_BLUR_MAX_PX),
		fit: z.enum(["cover", "contain", "fill", "tile"]),
		position: z.string().regex(POSITION_PATTERN, "must be a CSS background position"),
		wash: skinPaintSchema.nullable(),
	})
	.superRefine((artwork, context) => {
		const video = artwork.media !== null && isSkinVideoAsset(artwork.media);
		if (artwork.media === null && artwork.gradient === null) {
			context.addIssue({ code: "custom", message: "artwork needs media or a gradient" });
		}
		if (video && artwork.poster === null) {
			context.addIssue({ code: "custom", path: ["poster"], message: "video artwork needs a still poster" });
		}
		if (!video && artwork.poster !== null) {
			context.addIssue({ code: "custom", path: ["poster"], message: "poster is only valid for video artwork" });
		}
		if (video && artwork.fit === "tile") {
			context.addIssue({ code: "custom", path: ["fit"], message: "video artwork cannot use tile fit" });
		}
	});

export type SkinArtwork = z.infer<typeof skinArtworkSchema>;

const skinModeSchema = z
	.strictObject({
		palette: skinPaletteSchema,
		/** Optional authored surfaces; omitted roles use Ling's mode-specific material scale. */
		surfaces: z
			.strictObject({
				sidebar: skinColorSchema.optional(),
				header: skinColorSchema.optional(),
				statusbar: skinColorSchema.optional(),
				raised: skinColorSchema.optional(),
				input: skinColorSchema.optional(),
				code: skinColorSchema.optional(),
				composer: skinColorSchema.optional(),
				popover: skinColorSchema.optional(),
			})
			.optional(),
		primaryAction: z.strictObject({ background: skinColorSchema, foreground: skinColorSchema }).optional(),
		/** Selected choice controls inherit primaryAction unless the skin authors a separate pair. */
		choice: z.strictObject({ background: skinColorSchema, foreground: skinColorSchema }).optional(),
		artwork: skinArtworkSchema.nullable(),
	})
	.superRefine((mode, context) => {
		for (const role of ["primaryAction", "choice"] as const) {
			const pair = mode[role];
			if (pair && getContrast(pair.background, pair.foreground) < SKIN_FOREGROUND_CONTRAST_MIN) {
				context.addIssue({
					code: "custom",
					path: [role],
					message: "foreground and backing color must have at least 4.5:1 contrast",
				});
			}
		}
		for (const foreground of ["text", "accent", "secondary"] as const) {
			for (const surface of ["surface", "canvas"] as const) {
				if (getContrast(mode.palette[foreground], mode.palette[surface]) < SKIN_FOREGROUND_CONTRAST_MIN) {
					context.addIssue({
						code: "custom",
						path: ["palette", foreground],
						message: `must have at least ${String(SKIN_FOREGROUND_CONTRAST_MIN)}:1 contrast against ${surface}`,
					});
				}
			}
			for (const [role, surface] of Object.entries(mode.surfaces ?? {})) {
				// A role may be omitted in a partial surface scale, including in programmatic manifests.
				if (surface === undefined) continue;
				if (getContrast(mode.palette[foreground], surface) < SKIN_FOREGROUND_CONTRAST_MIN) {
					context.addIssue({
						code: "custom",
						path: ["surfaces", role],
						message: `must have at least ${String(SKIN_FOREGROUND_CONTRAST_MIN)}:1 contrast against ${foreground}`,
					});
				}
			}
		}
	});

export type SkinMode = z.infer<typeof skinModeSchema>;
export type SkinAppearanceMode = "light" | "dark";
export type SkinShape = "native" | "sharp" | "soft";
export type SkinMotion = "none" | "subtle" | "ambient";
export type SkinCodeTheme = "neutral" | "github" | "vitesse" | "catppuccin";
export type SkinTypography = "system" | "editorial" | "technical";

const skinManifestFields = {
	schemaVersion: z.literal(SKIN_SCHEMA_VERSION),
	id: z.string().regex(SKIN_ID_PATTERN, "must be a lowercase kebab-case skin id"),
	meta: z.strictObject({
		name: boundedText(SKIN_NAME_MAX_CHARS),
		description: boundedText(SKIN_DESCRIPTION_MAX_CHARS),
		author: boundedText(SKIN_AUTHOR_MAX_CHARS),
		license: boundedText(SKIN_LICENSE_MAX_CHARS),
	}),
	activate: z.boolean(),
	presentation: z.strictObject({
		shape: z.enum(["native", "sharp", "soft"]),
		/** Omission keeps rounded choices, except sharp skins which follow their control radius. */
		choiceShape: z.enum(["pill", "control"]).optional(),
		material: z.enum(["system", "solid"]),
		/** Existing v2 packages use soft elevation unless they author another surface treatment. */
		elevation: z.enum(["flat", "soft", "layered"]).optional(),
		motion: z.enum(["none", "subtle", "ambient"]),
		codeTheme: z.enum(["neutral", "github", "vitesse", "catppuccin"]),
		typography: z.enum(["system", "editorial", "technical"]),
	}),
};

const currentSkinManifestSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		...skinManifestFields,
		kind: z.literal("studio"),
		modes: z
			.strictObject({ light: skinModeSchema, dark: skinModeSchema })
			.refine(
				(modes) => modes.light.artwork?.media == null && modes.dark.artwork?.media == null,
				"studio skins use color or gradient surfaces; photo and video designs use kind art",
			),
	}),
	z.strictObject({
		...skinManifestFields,
		kind: z.literal("art"),
		appearance: z.enum(["light", "dark"]),
		mode: skinModeSchema.refine((mode) => mode.artwork !== null, {
			path: ["artwork"],
			message: "an art skin must supply artwork",
		}),
	}),
]);

const legacySkinModeSchema = skinModeSchema
	.safeExtend({ sceneInk: z.strictObject({ text: skinColorSchema, surface: skinColorSchema }).optional() })
	.superRefine((mode, context) => {
		if (mode.sceneInk && getContrast(mode.sceneInk.text, mode.sceneInk.surface) < SKIN_FOREGROUND_CONTRAST_MIN) {
			context.addIssue({ code: "custom", path: ["sceneInk"], message: "scene ink must have at least 4.5:1 contrast" });
		}
	});

const legacySkinManifestSchema = z
	.strictObject({
		...skinManifestFields,
		/** Version 2 stored two designs even when both used the same artwork. */
		schemaVersion: z.literal(2),
		modes: z.strictObject({ light: legacySkinModeSchema, dark: legacySkinModeSchema }),
	})
	.transform(({ schemaVersion: _version, modes, ...manifest }) => {
		const modeWithoutSceneInk = ({ sceneInk: _sceneInk, ...mode }: z.infer<typeof legacySkinModeSchema>) => mode;
		const lightHasMedia = modes.light.artwork?.media != null;
		const darkHasMedia = modes.dark.artwork?.media != null;
		const base = { ...manifest, schemaVersion: SKIN_SCHEMA_VERSION };
		if (!lightHasMedia && !darkHasMedia) {
			return {
				...base,
				kind: "studio" as const,
				modes: { light: modeWithoutSceneInk(modes.light), dark: modeWithoutSceneInk(modes.dark) },
			};
		}
		const scene = modes.light.sceneInk ?? modes.dark.sceneInk;
		// Legacy packages have no fixed-mode declaration. Keep the only illustrated design,
		// then honor authored scene polarity; when both are illustrated without a scene marker,
		// the documented migration default is their existing dark design.
		let appearance: SkinAppearanceMode = "dark";
		if (
			!darkHasMedia ||
			(lightHasMedia &&
				scene &&
				getContrast(modes.light.palette.text, scene.surface) >= getContrast(modes.dark.palette.text, scene.surface))
		)
			appearance = "light";
		return { ...base, kind: "art" as const, appearance, mode: modeWithoutSceneInk(modes[appearance]) };
	});

/** Legacy package input is normalized once; Host and Web share only the current contract. */
export const skinManifestSchema = z
	.union([currentSkinManifestSchema, legacySkinManifestSchema])
	// Nested treatments have already been normalized by either input branch.
	.pipe(
		currentSkinManifestSchema as z.ZodType<
			z.output<typeof currentSkinManifestSchema>,
			z.output<typeof currentSkinManifestSchema>
		>,
	);

export type SkinManifest = z.infer<typeof skinManifestSchema>;

export interface UserSkinSnapshot {
	id: string;
	/** Increments while Ling runs whenever this package changes, including artwork bytes. */
	revision: number;
	manifest: SkinManifest | null;
	error: string | null;
}

export interface UserSkinsSnapshot {
	dir: string;
	skins: UserSkinSnapshot[];
	/** Directory-level issue that did not prevent valid packages from loading. */
	error: string | null;
}

export function skinMediaUrl(id: string, asset: string, revision: number): string {
	const query = new URLSearchParams({ id, asset, revision: String(revision) });
	return `/api/media/skin?${query.toString()}`;
}
