import { mixSkinColor, readableSkinColor } from "./skin-color";
import summerBalconyHero from "@renderer/assets/skins/summer-balcony.jpg";
import futureSunsetHero from "@renderer/assets/skins/future-sunset.jpg";
import {
	SKIN_SCHEMA_VERSION,
	skinManifestSchema,
	type SkinArtwork,
	type SkinManifest,
	type SkinMode,
	type SkinPalette,
} from "@ling/contracts/skins";
import bluearchiveWakamoHero from "@renderer/assets/skins/bluearchive-wakamo.webp";
import bubbleNocturneHero from "@renderer/assets/skins/bubble-nocturne.webp";
import dnaAdaPoster from "@renderer/assets/skins/dna-ada-poster.webp";
import dnaAdaHero from "@renderer/assets/skins/dna-ada.webm";
import genshinArlecchinoHero from "@renderer/assets/skins/genshin-arlecchino.webp";
import genshinColumbinaPoster from "@renderer/assets/skins/genshin-columbina-poster.webp";
import genshinColumbinaHero from "@renderer/assets/skins/genshin-columbina.webm";
import hsrCyrenePoster from "@renderer/assets/skins/hsr-cyrene-poster.webp";
import hsrCyreneHero from "@renderer/assets/skins/hsr-cyrene.webm";
import noragamiYatoPoster from "@renderer/assets/skins/noragami-yato-poster.webp";
import noragamiYatoHero from "@renderer/assets/skins/noragami-yato.webm";
import porcelainMuseHero from "@renderer/assets/skins/porcelain-muse.webp";
import snowBladeHero from "@renderer/assets/skins/snow-blade.webp";
import wutheringCartethyiaHero from "@renderer/assets/skins/wuthering-cartethyia.webp";
import wutheringPhoebeHero from "@renderer/assets/skins/wuthering-phoebe.webp";
import wutheringShorekeeperHero from "@renderer/assets/skins/wuthering-shorekeeper.webp";
import wutheringYunoPoster from "@renderer/assets/skins/wuthering-yuno-poster.webp";
import wutheringYunoHero from "@renderer/assets/skins/wuthering-yuno.webm";

export interface BuiltinSkin {
	id: string;
	nameKey: string;
	descriptionKey: string;
	manifest: SkinManifest;
	assetUrl(asset: string): string;
}

/** Compact source data for Ling's packaged art skins. */
interface ArtSkinSource {
	id: string;
	/** The artwork's native luminance fixes the entire interface to its authored design. */
	appearance: "light" | "dark";
	accent: string;
	secondary: string;
	surface: string;
	text: string;
	hero: string;
	/** Still frame for the settings preview card when the hero is a video. */
	poster?: string;
	/** Subject location in the hero (percent) — anchors the cover crop on the character. */
	focus: { x: number; y: number };
	meta?: SkinManifest["meta"];
	presentation?: Partial<SkinManifest["presentation"]>;
}

const ART_SKINS: ArtSkinSource[] = [
	{
		id: "summer-balcony",
		appearance: "light",
		accent: "#1f6bd8",
		secondary: "#8b5524",
		surface: "#f5faff",
		text: "#0f1d33",
		hero: summerBalconyHero,
		focus: { x: 50, y: 50 },
		meta: {
			name: "Summer Balcony",
			description: "Clear summer blue and sunlit porcelain",
			author: "Custom",
			license: "Bundled with Ling",
		},
	},
	{
		id: "future-sunset",
		appearance: "dark",
		accent: "#ff8c4a",
		secondary: "#82c8ff",
		surface: "#172038",
		text: "#f5ebd9",
		hero: futureSunsetHero,
		focus: { x: 50, y: 50 },
		meta: {
			name: "Future Sunset",
			description: "Amber twilight over a midnight city",
			author: "Custom",
			license: "Bundled with Ling",
		},
		presentation: { shape: "sharp", typography: "editorial" },
	},
	{
		// Columbina under an icy aurora: her crimson feather tips as accent, glacial light as secondary.
		id: "genshin-columbina",
		appearance: "dark",
		accent: "#d04458",
		secondary: "#7fb8e8",
		surface: "#141f38",
		text: "#e0eaf8",
		hero: genshinColumbinaHero,
		poster: genshinColumbinaPoster,
		focus: { x: 45, y: 28 },
	},
	{
		// Phoebe among doves: royal indigo mantle as accent, golden hair against the rosy dawn.
		id: "wuthering-phoebe",
		appearance: "light",
		accent: "#3d55b8",
		secondary: "#c9822e",
		surface: "#f7f0ee",
		text: "#3c3550",
		hero: wutheringPhoebeHero,
		focus: { x: 58, y: 26 },
	},
	{
		// Cartethyia's orchard: forest green with the apple's red — already sampled from the art.
		id: "wuthering-cartethyia",
		appearance: "light",
		accent: "#3e8257",
		secondary: "#c85a4e",
		surface: "#f3f6ee",
		text: "#31473a",
		hero: wutheringCartethyiaHero,
		focus: { x: 70, y: 32 },
	},
	{
		// Shorekeeper in the white cathedral: butterfly ice-blue as accent, her violet eyes as secondary.
		id: "wuthering-shorekeeper",
		appearance: "light",
		accent: "#2e8bc4",
		secondary: "#a98fd6",
		surface: "#f4f4fa",
		text: "#37415c",
		hero: wutheringShorekeeperHero,
		focus: { x: 62, y: 24 },
	},
	{
		// Arlecchino in black silk and rain: the Knave's crimson as accent, silver-gray steel as secondary.
		id: "genshin-arlecchino",
		appearance: "dark",
		accent: "#e0324a",
		secondary: "#9aa2b5",
		surface: "#0e0c10",
		text: "#f0e8ec",
		hero: genshinArlecchinoHero,
		focus: { x: 60, y: 26 },
	},
	{
		// Ada's festival night: star-crown cyan with costume gold — already sampled from the art.
		id: "dna-ada",
		appearance: "dark",
		accent: "#4fc8e8",
		secondary: "#e0a75a",
		surface: "#12141f",
		text: "#e8ecf4",
		hero: dnaAdaHero,
		poster: dnaAdaPoster,
		focus: { x: 40, y: 35 },
	},
	{
		// Qipao muse among bamboo: porcelain blue florals as accent, the grove's celadon green as secondary.
		id: "porcelain-muse",
		appearance: "light",
		accent: "#2b6cb0",
		secondary: "#5f9070",
		surface: "#edf3f1",
		text: "#29363e",
		hero: porcelainMuseHero,
		focus: { x: 63, y: 22 },
	},
	{
		// Wakamo on a midnight shore: her wisteria violet as accent, the sunset's last amber as secondary.
		id: "bluearchive-wakamo",
		appearance: "dark",
		accent: "#a06ae8",
		secondary: "#e8956a",
		surface: "#171126",
		text: "#e6ddf2",
		hero: bluearchiveWakamoHero,
		focus: { x: 70, y: 36 },
	},
	{
		// Yuno perched under the giant moon: pale moonlight cyan as accent, her sapphire hair as secondary.
		id: "wuthering-yuno",
		appearance: "dark",
		accent: "#6fcfe4",
		secondary: "#5a78e0",
		surface: "#101a2e",
		text: "#dcecf6",
		hero: wutheringYunoHero,
		poster: wutheringYunoPoster,
		focus: { x: 62, y: 22 },
	},
	{
		// Cyrene adrift in a daydream sky: sakura rose as accent, her mint-tipped hair and the sky as secondary.
		id: "hsr-cyrene",
		appearance: "light",
		accent: "#c84b84",
		secondary: "#58b8c8",
		surface: "#f4f3fa",
		text: "#3d3350",
		hero: hsrCyreneHero,
		poster: hsrCyrenePoster,
		focus: { x: 76, y: 30 },
	},
	{
		// Yato over the manga collage: steel-blue blade light as accent, the ink gray as secondary.
		id: "noragami-yato",
		appearance: "dark",
		accent: "#7fb2e8",
		secondary: "#98a2b8",
		surface: "#0f1218",
		text: "#e4e9f2",
		hero: noragamiYatoHero,
		poster: noragamiYatoPoster,
		focus: { x: 47, y: 45 },
	},
	{
		// A white blade in falling snow: moonlit ice as accent, her crimson ribbon as secondary.
		id: "snow-blade",
		appearance: "dark",
		accent: "#9fc4ec",
		secondary: "#d04850",
		surface: "#131a28",
		text: "#e8eef8",
		hero: snowBladeHero,
		focus: { x: 67, y: 34 },
	},
	{
		// Lavender hair adrift among midnight bubbles: her hair's lilac as accent, the water glow as secondary.
		id: "bubble-nocturne",
		appearance: "dark",
		accent: "#d092e8",
		secondary: "#58b8e0",
		surface: "#0e1524",
		text: "#e0e6f4",
		hero: bubbleNocturneHero,
		focus: { x: 55, y: 40 },
	},
];

function paletteFor(theme: ArtSkinSource): SkinPalette {
	const dark = theme.appearance === "dark";
	const surface = theme.surface;
	// Keep 20% of the authored ink hue while giving prose enough contrast over the scene.
	const text = mixSkinColor(dark ? "#ffffff" : "#0c1018", theme.text, 0.2);
	// A 6% night / 5.5% daylight ink wash distinguishes the opaque canvas from its glass tint.
	const canvas = mixSkinColor(surface, text, dark ? 0.06 : 0.055);
	const readableAgainstMode = (color: string) =>
		readableSkinColor(color, [surface, canvas], dark ? "#ffffff" : "#111113");
	return {
		canvas,
		surface,
		text: readableAgainstMode(text),
		accent: readableAgainstMode(theme.accent),
		secondary: readableAgainstMode(theme.secondary),
	};
}

function artworkFor(theme: ArtSkinSource): SkinArtwork {
	return {
		media: theme.poster === undefined ? "assets/hero.webp" : "assets/hero.webm",
		poster: theme.poster === undefined ? null : "assets/poster.webp",
		gradient: null,
		opacity: 1,
		// Neutral exposure preserves the source image; the single palette supplies its reading ink.
		brightness: 1,
		contrast: 1,
		saturation: 1,
		blur: 0,
		fit: "cover",
		position: `${theme.focus.x}% ${theme.focus.y}%`,
		// Shared glass already tints navigation; a generated edge scrim would suppress it twice.
		wash: null,
	};
}

function buildSkin(theme: ArtSkinSource): BuiltinSkin {
	const palette = paletteFor(theme);
	const mode: SkinMode = {
		palette,
		surfaces: {
			sidebar: palette.surface,
			raised: palette.surface,
			input: palette.canvas,
			code: palette.canvas,
			composer: palette.surface,
			popover: palette.surface,
		},
		// Retain ink-first actions with an 18% contribution from the artwork's accent.
		primaryAction: { background: mixSkinColor(palette.text, palette.accent, 0.18), foreground: palette.surface },
		artwork: artworkFor(theme),
	};
	const parsedManifest = skinManifestSchema.safeParse({
		schemaVersion: SKIN_SCHEMA_VERSION,
		kind: "art",
		appearance: theme.appearance,
		id: theme.id,
		meta: theme.meta ?? {
			name: theme.id,
			description: "Bundled art skin",
			author: "Ling",
			license: "Bundled with Ling",
		},
		activate: false,
		mode,
		presentation: {
			shape: theme.appearance === "light" ? "soft" : "native",
			material: "system",
			elevation: "layered",
			motion: theme.poster === undefined ? "subtle" : "ambient",
			codeTheme: theme.appearance === "light" ? "vitesse" : "github",
			typography: "system",
			...theme.presentation,
		},
	});
	if (!parsedManifest.success) {
		const issues = parsedManifest.error.issues
			.map((issue) => `${issue.path.join(".") || "manifest"}: ${issue.message}`)
			.join("; ");
		throw new Error(`Invalid built-in skin ${theme.id}: ${issues}`);
	}
	const manifest = parsedManifest.data;
	const heroAsset = theme.poster === undefined ? "assets/hero.webp" : "assets/hero.webm";
	const assets: Record<string, string> = { [heroAsset]: theme.hero };
	if (theme.poster !== undefined) assets["assets/poster.webp"] = theme.poster;
	return {
		id: theme.id,
		nameKey: `skins.builtin_${theme.id}`,
		descriptionKey: `skins.builtin_${theme.id}_description`,
		manifest,
		assetUrl: (asset) => {
			const url = assets[asset];
			if (url === undefined) throw new Error(`Missing built-in skin asset ${theme.id}/${asset}`);
			return url;
		},
	};
}

export const DEFAULT_SKIN_MANIFEST = skinManifestSchema.parse({
	schemaVersion: SKIN_SCHEMA_VERSION,
	kind: "studio",
	id: "ling-neutral",
	meta: {
		name: "Ling Neutral",
		description: "Quiet monochrome surfaces for focused work",
		author: "Ling",
		license: "Bundled with Ling",
	},
	activate: false,
	modes: {
		light: {
			palette: {
				canvas: "#f2f2f3",
				surface: "#ffffff",
				text: "#1a1a1d",
				accent: "#006dd3",
				secondary: "#0f766e",
			},
			artwork: null,
		},
		dark: {
			palette: {
				canvas: "#0d0d0f",
				surface: "#19191c",
				text: "#f5f5f7",
				accent: "#5aa7ff",
				secondary: "#82d4c8",
			},
			artwork: null,
		},
	},
	presentation: {
		shape: "native",
		material: "system",
		motion: "subtle",
		codeTheme: "neutral",
		typography: "system",
	},
});

/** Studio scenes use static, local paint rather than decoded media or animated filters. */
function createStudioArtwork(design: Pick<SkinArtwork, "gradient" | "treatment" | "layers">): SkinArtwork {
	return {
		scope: "window",
		media: null,
		poster: null,
		opacity: 1,
		brightness: 1,
		contrast: 1,
		saturation: 1,
		blur: 0,
		fit: "cover",
		position: "center",
		wash: null,
		...design,
	};
}

/** Studio materials have independently authored light/dark surfaces; no image assets are needed. */
const STUDIO_SKINS: Extract<SkinManifest, { kind: "studio" }>[] = [
	{
		schemaVersion: SKIN_SCHEMA_VERSION,
		kind: "studio",
		id: "rose",
		meta: {
			name: "Rose",
			description: "Rose paper with layered blush and pearlescent light",
			author: "Ling",
			license: "MIT",
		},
		activate: false,
		modes: {
			light: {
				palette: { canvas: "#f5e4eb", surface: "#fff5f8", text: "#452c3b", accent: "#913356", secondary: "#71507b" },
				surfaces: {
					sidebar: "#f7e7ee",
					raised: "#fff9fb",
					input: "#f7e9ef",
					code: "#faedf2",
					composer: "#fff9fb",
					popover: "#fff9fb",
				},
				primaryAction: { background: "#81314f", foreground: "#fff5f8" },
				artwork: createStudioArtwork({
					gradient: "linear-gradient(135deg, #fff0f5, #efd7e2)",
					treatment: { kind: "paper", strength: 0.45 },
					layers: [
						{
							id: "rose-bloom",
							paint: "radial-gradient(ellipse at 90% 5%, #df9ebc, #df9ebc00 65%)",
							opacity: 0.55,
							blend: "multiply",
						},
						{
							id: "pearl-light",
							paint: "linear-gradient(120deg, #ffffff00 20%, #ffffff 48%, #dcc5e800 78%)",
							opacity: 0.55,
							blend: "soft-light",
							mask: "radial-gradient(ellipse at 25% 80%, #000000, #00000000 75%)",
						},
					],
				}),
			},
			dark: {
				palette: { canvas: "#251820", surface: "#30212b", text: "#fae7ef", accent: "#eeb0c9", secondary: "#d5bae5" },
				surfaces: {
					sidebar: "#291c24",
					raised: "#3b2934",
					input: "#291c24",
					code: "#291c24",
					composer: "#3b2934",
					popover: "#3b2934",
				},
				primaryAction: { background: "#edb0c7", foreground: "#35212d" },
				artwork: createStudioArtwork({
					gradient: "linear-gradient(135deg, #291b24, #382330)",
					treatment: { kind: "paper", strength: 0.4 },
					layers: [
						{
							id: "rose-bloom",
							paint: "radial-gradient(ellipse at 90% 5%, #7b465e, #7b465e00 65%)",
							opacity: 0.35,
							blend: "screen",
						},
						{
							id: "pearl-light",
							paint: "linear-gradient(120deg, #c7a2d000 20%, #c7a2d0 48%, #c7a2d000 78%)",
							opacity: 0.3,
							blend: "soft-light",
							mask: "radial-gradient(ellipse at 25% 80%, #000000, #00000000 75%)",
						},
					],
				}),
			},
		},
		presentation: {
			shape: "soft",
			material: "system",
			elevation: "layered",
			motion: "subtle",
			codeTheme: "catppuccin",
			typography: "system",
		},
	},
	{
		schemaVersion: SKIN_SCHEMA_VERSION,
		id: "linen",
		kind: "studio",
		meta: { name: "Linen", description: "Woven flax, warm ink, and softly lit edges", author: "Ling", license: "MIT" },
		activate: false,
		modes: {
			light: {
				palette: { canvas: "#eee9df", surface: "#faf7f0", text: "#302b25", accent: "#77532b", secondary: "#526346" },
				surfaces: { sidebar: "#eee9df", raised: "#fffdf7", input: "#f1ece3", code: "#f2ede4", composer: "#fffdf7" },
				artwork: createStudioArtwork({
					gradient: "linear-gradient(125deg, #f3ede2, #e5dccb)",
					treatment: { kind: "linen", strength: 0.38 },
					layers: [
						{
							id: "window-light",
							paint: "radial-gradient(ellipse at 10% 0%, #fffdf4, #fffdf400 75%)",
							opacity: 0.75,
							blend: "soft-light",
						},
						{
							id: "flax-edge",
							paint: "linear-gradient(110deg, #a58c6000 55%, #a58c60)",
							opacity: 0.15,
							blend: "multiply",
							mask: "linear-gradient(0deg, #000000, #00000000 80%)",
						},
					],
				}),
			},
			dark: {
				palette: { canvas: "#181714", surface: "#23211d", text: "#ede6d8", accent: "#d6b484", secondary: "#b5c5a5" },
				surfaces: { sidebar: "#181714", raised: "#2d2a24", input: "#1c1a17", code: "#1c1a17", composer: "#2b2822" },
				artwork: createStudioArtwork({
					gradient: "linear-gradient(125deg, #29261f, #1b1915)",
					treatment: { kind: "linen", strength: 0.42 },
					layers: [
						{
							id: "window-light",
							paint: "radial-gradient(ellipse at 10% 0%, #bca477, #bca47700 75%)",
							opacity: 0.35,
							blend: "soft-light",
						},
						{
							id: "flax-edge",
							paint: "linear-gradient(110deg, #0f0d0900 55%, #0f0d09)",
							opacity: 0.25,
							blend: "multiply",
							mask: "linear-gradient(0deg, #000000, #00000000 80%)",
						},
					],
				}),
			},
		},
		presentation: {
			shape: "native",
			material: "system",
			elevation: "flat",
			motion: "subtle",
			codeTheme: "vitesse",
			typography: "editorial",
		},
	},
	{
		schemaVersion: SKIN_SCHEMA_VERSION,
		id: "celadon",
		kind: "studio",
		meta: { name: "Celadon", description: "Layered jade glaze and diffused daylight", author: "Ling", license: "MIT" },
		activate: false,
		modes: {
			light: {
				palette: { canvas: "#e1ece8", surface: "#f3f8f5", text: "#183d36", accent: "#24665a", secondary: "#52613a" },
				surfaces: { sidebar: "#dfece5", raised: "#f7fbf8", input: "#e7f0eb", code: "#eaf2ed", composer: "#f7fbf8" },
				artwork: createStudioArtwork({
					gradient: "linear-gradient(145deg, #ecf3ee, #c9dfd5)",
					treatment: { kind: "glass", blur: 8 },
					layers: [
						{
							id: "jade-pool",
							paint: "radial-gradient(ellipse at 90% 15%, #76ad9a, #76ad9a00 65%)",
							opacity: 0.4,
							blend: "multiply",
						},
						{
							id: "glaze-light",
							paint: "linear-gradient(115deg, #ffffff00 15%, #ffffff 40%, #ffffff00 65%)",
							opacity: 0.8,
							blend: "soft-light",
							mask: "radial-gradient(ellipse at 30% 25%, #000000, #00000000 80%)",
						},
					],
				}),
			},
			dark: {
				palette: { canvas: "#111e1b", surface: "#192c26", text: "#dfefe6", accent: "#9ed3bf", secondary: "#c1cf9a" },
				surfaces: { sidebar: "#152720", raised: "#243a31", input: "#14261f", code: "#152820", composer: "#243a31" },
				artwork: createStudioArtwork({
					gradient: "linear-gradient(145deg, #14241f, #1b352c)",
					treatment: { kind: "glass", blur: 8 },
					layers: [
						{
							id: "jade-pool",
							paint: "radial-gradient(ellipse at 90% 15%, #4a7a65, #4a7a6500 65%)",
							opacity: 0.3,
							blend: "screen",
						},
						{
							id: "glaze-light",
							paint: "linear-gradient(115deg, #c3ddbc00 15%, #c3ddbc 40%, #c3ddbc00 65%)",
							opacity: 0.3,
							blend: "soft-light",
							mask: "radial-gradient(ellipse at 30% 25%, #000000, #00000000 80%)",
						},
					],
				}),
			},
		},
		presentation: {
			shape: "soft",
			material: "system",
			elevation: "layered",
			motion: "subtle",
			codeTheme: "vitesse",
			typography: "system",
		},
	},
	{
		schemaVersion: SKIN_SCHEMA_VERSION,
		id: "blueprint",
		kind: "studio",
		meta: {
			name: "Blueprint",
			description: "Faded drafting grids with cool ink and precise geometry",
			author: "Ling",
			license: "MIT",
		},
		activate: false,
		modes: {
			light: {
				palette: { canvas: "#e6ebf2", surface: "#f7f9fc", text: "#223249", accent: "#285fa5", secondary: "#5d518f" },
				surfaces: { sidebar: "#e6ebf2", raised: "#ffffff", input: "#eaf0f7", code: "#eef2f8", composer: "#ffffff" },
				artwork: createStudioArtwork({
					gradient: "linear-gradient(145deg, #edf2f8, #dce6f1)",
					treatment: { kind: "clear" },
					layers: [
						// A 24px drafting grid fades through the central reading column.
						{
							id: "draft-grid",
							paint:
								"repeating-linear-gradient(0deg, #285fa5 0px 1px, #285fa500 1px 24px), repeating-linear-gradient(90deg, #285fa5 0px 1px, #285fa500 1px 24px)",
							opacity: 0.14,
							blend: "multiply",
							mask: "linear-gradient(90deg, #000000, #00000000 35%, #00000000 65%, #000000)",
						},
						{
							id: "draft-light",
							paint: "radial-gradient(ellipse at 60% 0%, #ffffff, #ffffff00 80%)",
							opacity: 0.65,
							blend: "soft-light",
						},
					],
				}),
			},
			dark: {
				palette: { canvas: "#101824", surface: "#182436", text: "#e1eaf6", accent: "#9fc5ff", secondary: "#c0b5ef" },
				surfaces: { sidebar: "#101824", raised: "#233249", input: "#142032", code: "#131e2e", composer: "#203047" },
				artwork: createStudioArtwork({
					gradient: "linear-gradient(145deg, #152236, #101b2b)",
					treatment: { kind: "clear" },
					layers: [
						{
							id: "draft-grid",
							paint:
								"repeating-linear-gradient(0deg, #9fc5ff 0px 1px, #9fc5ff00 1px 24px), repeating-linear-gradient(90deg, #9fc5ff 0px 1px, #9fc5ff00 1px 24px)",
							opacity: 0.16,
							blend: "screen",
							mask: "linear-gradient(90deg, #000000, #00000000 35%, #00000000 65%, #000000)",
						},
						{
							id: "draft-light",
							paint: "radial-gradient(ellipse at 60% 0%, #789dcc, #789dcc00 80%)",
							opacity: 0.25,
							blend: "soft-light",
						},
					],
				}),
			},
		},
		presentation: {
			shape: "sharp",
			material: "system",
			elevation: "soft",
			motion: "subtle",
			codeTheme: "github",
			typography: "technical",
		},
	},
];

export const BUILTIN_SKINS: BuiltinSkin[] = [
	...STUDIO_SKINS.map((source): BuiltinSkin => {
		const studioMode = (mode: SkinMode) => ({
			...mode,
			surfaces: { ...mode.surfaces, popover: mode.surfaces?.popover ?? mode.surfaces?.raised ?? mode.palette.surface },
			primaryAction: mode.primaryAction ?? { background: mode.palette.text, foreground: mode.palette.surface },
		});
		const manifest = skinManifestSchema.parse({
			...source,
			modes: { light: studioMode(source.modes.light), dark: studioMode(source.modes.dark) },
		});
		return {
			id: manifest.id,
			nameKey: `skins.builtin_${manifest.id}`,
			descriptionKey: `skins.builtin_${manifest.id}_description`,
			manifest,
			assetUrl: (asset) => {
				throw new Error(`Studio skin ${manifest.id} has no artwork asset ${asset}`);
			},
		};
	}),
	...ART_SKINS.map(buildSkin),
];
