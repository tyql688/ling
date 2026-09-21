import {
	DEFAULT_SKIN_DITHER_TREATMENT,
	isSkinVideoAsset,
	SKIN_FOREGROUND_CONTRAST_MIN,
	type SkinAppearanceMode,
	type SkinArtwork,
	type SkinArtworkScope,
	type SkinArtworkTreatment,
	type SkinManifest,
	type SkinMode,
	type SkinPalette,
	type SkinShape,
	type SkinTypography,
} from "@ling/contracts/skins";
import type { SkinSceneOverride } from "@ling/contracts/user-state";
import { getContrast } from "color2k";
import { mixSkinColor, readableSkinColor, skinColorWithAlpha } from "./skin-color";

export type SkinExpression = "balanced" | "immersive";
type SkinStyleVariables = Record<`--${string}`, string>;

export interface ResolvedSkinArtwork {
	scope: SkinArtworkScope;
	treatment: SkinArtworkTreatment;
	layers: NonNullable<SkinArtwork["layers"]>;
	mask: string | null;
	canvas: string;
	mediaUrl: string | null;
	posterUrl: string | null;
	gradient: string | null;
	opacity: number;
	washOpacity: number;
	blur: number;
	brightness: number;
	contrast: number;
	saturation: number;
	fit: SkinArtwork["fit"];
	position: string;
	wash: string | null;
	video: boolean;
}

export const SKIN_TREATMENTS: Record<SkinArtworkTreatment["kind"], SkinArtworkTreatment> = {
	clear: { kind: "clear" },
	glass: { kind: "glass" },
	dither: DEFAULT_SKIN_DITHER_TREATMENT,
	// Soft-light patterns need more coverage than solid paint to reveal their grain without flattening the artwork.
	paper: { kind: "paper", strength: 0.65 },
	linen: { kind: "linen", strength: 0.6 },
	scanlines: { kind: "scanlines", strength: 0.5 },
};

/** One is the identity value for brightness, contrast, and saturation filters. */
const NEUTRAL_ARTWORK_TONE = 1;

export function resolvedArtworkFilter(artwork: ResolvedSkinArtwork): string | undefined {
	const filters: string[] = [];
	if (artwork.blur > 0) filters.push(`blur(${String(artwork.blur)}px)`);
	if (artwork.brightness !== NEUTRAL_ARTWORK_TONE) filters.push(`brightness(${String(artwork.brightness)})`);
	if (artwork.contrast !== NEUTRAL_ARTWORK_TONE) filters.push(`contrast(${String(artwork.contrast)})`);
	if (artwork.saturation !== NEUTRAL_ARTWORK_TONE) filters.push(`saturate(${String(artwork.saturation)})`);
	return filters.length === 0 ? undefined : filters.join(" ");
}

export interface ResolvedSkinMode {
	appearance: SkinAppearanceMode;
	palette: SkinPalette;
	surfaces: Record<"sidebar" | "header" | "statusbar" | "raised" | "input" | "code" | "composer" | "popover", string>;
	vars: SkinStyleVariables;
	artwork: ResolvedSkinArtwork | null;
}

export type ResolvedSkin = {
	manifest: SkinManifest;
	forceOpaque: boolean;
} & ({ kind: "studio"; modes: Record<SkinAppearanceMode, ResolvedSkinMode> } | { kind: "art"; mode: ResolvedSkinMode });

/** Studio skins follow the saved preference; artwork always selects its authored appearance. */
export function selectResolvedSkinMode(resolved: ResolvedSkin, appearance: SkinAppearanceMode): ResolvedSkinMode {
	return resolved.kind === "art" ? resolved.mode : resolved.modes[appearance];
}

export const SKIN_SCENE_VISIBILITY: Record<SkinExpression, number> = {
	// One scene mix is shared by navigation, chrome, and conversation; controls remain readable above it.
	balanced: 60,
	immersive: 90,
};

const SCENE_GLASS_FILTER: Record<SkinExpression, string> = {
	// A 12px frost softens fine texture; 110% saturation offsets the neutral surface tint.
	balanced: "blur(12px) saturate(110%)",
	// A 4px frost keeps the immersive scene recognizable without compressing its tonal range.
	immersive: "blur(4px) saturate(110%)",
};

interface ShapeScale {
	sm: string;
	control: string;
	panel: string;
}

// Authored shape preferences select from the same four radii as built-in controls.
const SHAPE_SCALES: Record<SkinShape, ShapeScale> = {
	native: { sm: "6px", control: "8px", panel: "12px" },
	sharp: { sm: "6px", control: "6px", panel: "8px" },
	soft: { sm: "8px", control: "12px", panel: "12px" },
};

interface TypographyProfile {
	sans: string;
	mono: string;
}

const TYPOGRAPHY_PROFILES: Record<SkinTypography, TypographyProfile> = {
	system: {
		sans: 'ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"',
		mono: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
	},
	editorial: {
		sans: '"Avenir Next", Avenir, "Segoe UI", ui-sans-serif, system-ui, sans-serif',
		mono: '"SFMono-Regular", "JetBrains Mono", Menlo, Consolas, ui-monospace, monospace',
	},
	technical: {
		sans: '"IBM Plex Sans", "SF Pro Text", "Segoe UI", ui-sans-serif, system-ui, sans-serif',
		mono: '"JetBrains Mono", "SFMono-Regular", Menlo, Consolas, ui-monospace, monospace',
	},
};

function translucent(color: string, percent: number): string {
	return percent >= 100 ? color : `color-mix(in srgb, ${color} ${String(percent)}%, transparent)`;
}

function foregroundOn(color: string): string {
	const dark = "#111113";
	const light = "#ffffff";
	return getContrast(dark, color) >= getContrast(light, color) ? dark : light;
}

/** Keep valid custom skins readable even when their authored ink needs an opaque backing. */
function resolveSceneProtection(text: string, surfaces: readonly string[], minimumOpacity: number) {
	// Strengthen in 1% steps until both extreme backdrops pass AA. Protection depends
	// on authored colors and the reading surface, never scene visibility.
	for (let opacity = minimumOpacity; opacity <= 100; opacity += 1) {
		const backdrops = surfaces.flatMap((surface) => [
			mixSkinColor("#000000", surface, opacity / 100),
			mixSkinColor("#ffffff", surface, opacity / 100),
		]);
		if (backdrops.every((backdrop) => getContrast(text, backdrop) >= SKIN_FOREGROUND_CONTRAST_MIN)) {
			return { opacity, backdrops };
		}
	}
	throw new Error("Skin scene has no readable foreground");
}

function resolveInlineCodeMaterial(surface: string, text: string, palette: SkinPalette, glass: boolean) {
	// The original chip uses a 5% ink wash. AA-boundary palettes retain their validated
	// surface when that wash would reduce contrast below the normal-text minimum.
	const wash = mixSkinColor(surface, text, 0.05);
	const background = getContrast(text, wash) >= SKIN_FOREGROUND_CONTRAST_MIN ? wash : surface;
	// Small monospace glyphs need at least 92% protection over moving or contrasting art.
	const protection = glass ? resolveSceneProtection(text, [background], 92) : { opacity: 100, backdrops: [background] };
	return {
		background: translucent(background, protection.opacity),
		foreground: readableSkinColor(palette.secondary, protection.backdrops, text),
		link: readableSkinColor(palette.accent, protection.backdrops, text),
	};
}

function semanticColors(dark: boolean) {
	return dark
		? {
				danger: "#ff6764",
				success: "#40c977",
				warning: "#ff9a5c",
				info: "#5aaeff",
				purple: "#a78bfa",
				teal: "#4fd1a5",
			}
		: {
				danger: "#d92d2a",
				success: "#087f3d",
				warning: "#b54708",
				info: "#006dd3",
				purple: "#7357d8",
				teal: "#087f68",
			};
}

function ansiColors(dark: boolean): SkinStyleVariables {
	return dark
		? {
				"--ansi-black": "#ffffff",
				"--ansi-red": "#f67576",
				"--ansi-green": "#85df7b",
				"--ansi-yellow": "#fa994c",
				"--ansi-blue": "#3d8dff",
				"--ansi-magenta": "#b06dff",
				"--ansi-cyan": "#6dcbf4",
				"--ansi-white": "#999999",
				"--ansi-bright-black": "#777777",
				"--ansi-bright-red": "#ff8586",
				"--ansi-bright-green": "#96ed8d",
				"--ansi-bright-yellow": "#ffad69",
				"--ansi-bright-blue": "#64a5ff",
				"--ansi-bright-magenta": "#c18cff",
				"--ansi-bright-cyan": "#8bdbff",
				"--ansi-bright-white": "#d8d8d8",
			}
		: {
				"--ansi-black": "#000000",
				"--ansi-red": "#c92f32",
				"--ansi-green": "#087f16",
				"--ansi-yellow": "#9c4a00",
				"--ansi-blue": "#174fc7",
				"--ansi-magenta": "#6f35b5",
				"--ansi-cyan": "#006e8a",
				"--ansi-white": "#666666",
				"--ansi-bright-black": "#555555",
				"--ansi-bright-red": "#e34649",
				"--ansi-bright-green": "#3d9d3f",
				"--ansi-bright-yellow": "#c56616",
				"--ansi-bright-blue": "#006aff",
				"--ansi-bright-magenta": "#8a4bd1",
				"--ansi-bright-cyan": "#168dad",
				"--ansi-bright-white": "#828282",
			};
}

function resolveVariables(
	mode: SkinMode,
	surfaces: ResolvedSkinMode["surfaces"],
	mutedText: string,
	appearance: SkinAppearanceMode,
	expression: SkinExpression,
	manifest: SkinManifest,
	forceOpaque: boolean,
	artwork: ResolvedSkinArtwork | null,
) {
	const { palette } = mode;
	const dark = appearance === "dark";
	const systemMaterial = !forceOpaque && manifest.presentation.material === "system";
	const glass = mode.artwork !== null && systemMaterial;
	const windowScene = artwork?.scope === "window";
	const sceneFilter =
		artwork?.treatment.kind === "glass"
			? artwork.treatment.blur === undefined
				? SCENE_GLASS_FILTER[expression]
				: `blur(${String(artwork.treatment.blur)}px) saturate(110%)`
			: "none";
	const sceneText = palette.text;
	const sceneBacking = palette.surface;
	const primaryBackground = mode.primaryAction?.background ?? palette.text;
	const primaryForeground = mode.primaryAction?.foreground ?? palette.surface;
	// Optional choice ink inherits the skin's primary action pair at the manifest boundary.
	const choiceBackground = mode.choice?.background ?? primaryBackground;
	const choiceForeground = mode.choice?.foreground ?? primaryForeground;
	// A 4% light / 6% dark ink wash gives opaque hover feedback. AA-boundary skins keep
	// the validated raised surface rather than trading text contrast for a hover tint.
	const choiceHoverCandidate = mixSkinColor(surfaces.raised, palette.text, dark ? 0.06 : 0.04);
	const choiceHover =
		getContrast(palette.text, choiceHoverCandidate) >= SKIN_FOREGROUND_CONTRAST_MIN
			? choiceHoverCandidate
			: surfaces.raised;
	// A 6% shift toward the contrasting endpoint changes the fill without fading its label.
	const primaryHover = mixSkinColor(primaryBackground, foregroundOn(primaryForeground), 0.06);
	const contrastSurfaces = [palette.surface, palette.canvas, ...Object.values(surfaces)];
	const semantic = semanticColors(dark);
	// Status text shares the same contrast boundary as authored accent and secondary colors.
	for (const key of Object.keys(semantic) as (keyof typeof semantic)[]) {
		semantic[key] = readableSkinColor(semantic[key], contrastSurfaces, palette.text);
	}
	const shape = SHAPE_SCALES[manifest.presentation.shape];
	const choiceShape =
		manifest.presentation.choiceShape ?? (manifest.presentation.shape === "sharp" ? "control" : "pill");
	const typography = TYPOGRAPHY_PROFILES[manifest.presentation.typography];
	const nativeMaterial = mode.artwork === null && systemMaterial;
	const sceneOpacity = glass ? 100 - SKIN_SCENE_VISIBILITY[expression] : 100;
	const sceneSurface = (color: string) =>
		nativeMaterial
			? `color-mix(in srgb, ${color} var(--native-tint-opacity, 100%), transparent)`
			: translucent(color, sceneOpacity);
	const chromeSurface = (color: string) => (glass && !windowScene ? color : sceneSurface(color));
	const sceneBase = palette.surface;
	// Artwork-backed input starts at 68%. Over a transparent native window, Chromium's
	// blur retains sharp source alpha, so an 88% backing also suppresses transcript glyphs.
	// Check both authored backings; neither scene visibility nor native tint fades the ink.
	const sceneProtection = systemMaterial
		? resolveSceneProtection(sceneText, [sceneBase, surfaces.composer], nativeMaterial ? 88 : 68)
		: { opacity: 100, backdrops: contrastSurfaces };
	// Full-height readers carry small labels. Start them at 84% and strengthen only palettes
	// that need more protection over the light and dark scene extremes.
	const readingProtection = glass
		? resolveSceneProtection(sceneText, manifest.kind === "art" ? [sceneBase] : [sceneBase, surfaces.code], 84)
		: { opacity: 100, backdrops: contrastSurfaces };
	const navigationProtection =
		glass && windowScene
			? resolveSceneProtection(sceneText, [surfaces.sidebar], 84)
			: { opacity: 100, backdrops: contrastSurfaces };
	const readingOpacity = windowScene ? readingProtection.opacity : 100;
	const navigationOpacity = navigationProtection.opacity;
	// Artwork skins use one full-height material across chrome, navigation, readers and tools.
	// Studio skins retain the distinct authored roles in their light and dark modes.
	const artworkWorkspace = manifest.kind === "art";
	const artworkWorkspaceSurface = translucent(sceneBase, readingOpacity);
	const inlineCode = resolveInlineCodeMaterial(surfaces.raised, palette.text, palette, false);
	const sceneInlineCode = glass ? resolveInlineCodeMaterial(sceneBase, sceneText, palette, true) : inlineCode;
	// Start secondary text at 72% ink, strengthening it only when the protected backdrop requires it.
	const sceneMuted = readableSkinColor(mixSkinColor(sceneBase, sceneText, 0.72), sceneProtection.backdrops, sceneText);
	const sceneAccent = readableSkinColor(palette.accent, sceneProtection.backdrops, sceneText);
	const sceneSemantic = semanticColors(dark);
	for (const key of Object.keys(sceneSemantic) as (keyof typeof sceneSemantic)[]) {
		sceneSemantic[key] = readableSkinColor(sceneSemantic[key], sceneProtection.backdrops, sceneText);
	}
	// Conversation code shares the reader's protected material so opening a document does not
	// introduce another opacity tier inside the same workspace.
	const sceneCodeSurface = surfaces.code;
	const sceneCodeOpacity = glass ? Math.max(readingProtection.opacity, sceneProtection.opacity) : 100;
	const sceneColorScheme = foregroundOn(sceneCodeSurface) === "#ffffff" ? "dark" : "light";
	// A 48% light / 56% dark wash protects table cells over contrasting artwork details.
	// It stays thinner than code and disappears entirely on an art-free reading plane.
	const sceneTableOpacity = glass ? (sceneColorScheme === "dark" ? 56 : 48) : 0;
	const elevation = manifest.presentation.elevation ?? "soft";
	// Highlights reveal a glass edge without whitening its face; shadows follow the skin's neutral hue.
	const edge = skinColorWithAlpha(dark ? palette.text : "#ffffff", dark ? 0.1 : 0.65);
	const shadow = skinColorWithAlpha(dark ? "#000000" : palette.text, dark ? 0.24 : 0.1);
	const readingShadow = elevation === "flat" ? "none" : `inset 0 1px 0 ${edge}, 0 2px 8px ${shadow}`;
	const floatingShadow =
		elevation === "flat"
			? "none"
			: `inset 0 1px 0 ${edge}, 0 ${elevation === "layered" ? "16px 48px" : "8px 24px"} ${shadow}, 0 1px 4px ${shadow}`;
	// Light skins tint through their dark text at 18%; dark skins use 60% of their canvas so modal scrims never turn white.
	const overlay = skinColorWithAlpha(dark ? palette.canvas : palette.text, dark ? 0.6 : 0.18);
	const variables: SkinStyleVariables = {
		"--color-surface": palette.surface,
		"--color-shell-content": systemMaterial && (!glass || windowScene) ? "transparent" : palette.surface,
		// Startup paint: theme-init reads this from the boot cache so the body carries the skin
		// canvas before React mounts (SkinBackdrop otherwise only exists after first render).
		"--color-skin-canvas": palette.canvas,
		// The viewport already owns its material; loading must not add a second tint over it.
		"--color-loading-veil": systemMaterial ? "transparent" : palette.surface,
		"--color-surface-raised": surfaces.raised,
		"--color-header": artworkWorkspace ? artworkWorkspaceSurface : chromeSurface(surfaces.header),
		"--color-sidebar": artworkWorkspace ? artworkWorkspaceSurface : chromeSurface(surfaces.sidebar),
		"--color-sidebar-preview": artworkWorkspace
			? artworkWorkspaceSurface
			: translucent(surfaces.sidebar, navigationOpacity),
		"--color-panel": artworkWorkspace ? artworkWorkspaceSurface : translucent(palette.surface, readingOpacity),
		"--color-conversation": sceneSurface(palette.surface),
		"--color-card": surfaces.raised,
		// Artwork workbenches stay on the same plane from the project sidebar through the contextual
		// navigator. Syntax colors and inline code still use the authored code role above that plane.
		"--color-workbench-surface": artworkWorkspace
			? artworkWorkspaceSurface
			: translucent(surfaces.code, readingOpacity),
		"--color-workbench-side": artworkWorkspace
			? artworkWorkspaceSurface
			: translucent(surfaces.sidebar, navigationOpacity),
		"--color-popover": translucent(surfaces.popover, windowScene ? 96 : 100),
		"--color-overlay": overlay,
		"--color-input": surfaces.input,
		"--color-surface-under": windowScene ? "transparent" : chromeSurface(palette.canvas),
		"--color-surface-hover": skinColorWithAlpha(palette.text, dark ? 0.06 : 0.05),
		"--color-border-subtle": skinColorWithAlpha(palette.text, dark ? 0.13 : 0.12),
		"--color-border-strong": skinColorWithAlpha(palette.text, dark ? 0.28 : 0.24),
		"--color-text-primary": palette.text,
		"--color-text-muted": mutedText,
		"--color-surface-text": palette.text,
		"--color-surface-text-muted": mutedText,
		"--color-surface-accent": palette.accent,
		"--color-scene-text": sceneText,
		"--color-scene-text-muted": glass ? mixSkinColor(sceneBacking, sceneText, 0.92) : mutedText,
		"--color-scene-accent": glass ? readableSkinColor(palette.accent, [sceneBacking], sceneText) : palette.accent,
		"--color-scene-surface": sceneBase,
		"--color-scene-control-muted": systemMaterial ? sceneMuted : mutedText,
		"--color-scene-control-accent": sceneAccent,
		"--color-scene-control-accent-foreground": foregroundOn(sceneAccent),
		"--color-scene-danger": sceneSemantic.danger,
		"--color-scene-warning": sceneSemantic.warning,
		"--color-scene-success": sceneSemantic.success,
		// One 80% reading plane protects chart labels, rather than stacking opaque chart cards.
		"--color-scene-reading": translucent(sceneBase, glass ? Math.max(80, sceneProtection.opacity) : 100),
		"--color-today-usage": windowScene ? translucent(sceneBase, sceneProtection.opacity) : "transparent",
		"--color-scene-code-block": translucent(sceneCodeSurface, sceneCodeOpacity),
		"--color-scene-table": translucent(glass ? sceneBacking : palette.surface, sceneTableOpacity),
		"--color-scene-inline-code": sceneInlineCode.foreground,
		"--color-scene-inline-code-bg": sceneInlineCode.background,
		"--color-scene-inline-code-link": sceneInlineCode.link,
		"--scene-color-scheme": sceneColorScheme,
		"--color-accent": palette.accent,
		"--color-accent-muted": skinColorWithAlpha(palette.accent, dark ? 0.16 : 0.1),
		"--color-accent-foreground": foregroundOn(palette.accent),
		"--color-danger": semantic.danger,
		"--color-success": semantic.success,
		"--color-warning": semantic.warning,
		"--color-diff-added": semantic.success,
		"--color-diff-removed": semantic.danger,
		"--color-git-added": semantic.success,
		"--color-git-deleted": semantic.danger,
		"--color-git-modified": semantic.info,
		"--color-git-renamed": semantic.purple,
		"--color-git-untracked": semantic.teal,
		"--color-context-low": semantic.success,
		"--color-context-medium": semantic.warning,
		"--color-context-high": semantic.danger,
		"--color-status-info": semantic.info,
		"--color-status-success": semantic.success,
		"--color-status-warning": semantic.warning,
		"--color-status-danger": semantic.danger,
		"--color-btn-primary": primaryBackground,
		"--color-btn-primary-foreground": primaryForeground,
		"--color-btn-primary-hover": primaryHover,
		"--color-choice-selected": choiceBackground,
		"--color-choice-selected-foreground": choiceForeground,
		"--color-choice-hover": choiceHover,
		"--color-danger-foreground": foregroundOn(semantic.danger),
		"--color-attention-glow": palette.accent,
		"--color-inline-code": inlineCode.foreground,
		"--color-inline-code-bg": inlineCode.background,
		"--color-inline-code-link": inlineCode.link,
		"--color-alert-important": palette.secondary,
		// Messages retain at least 74% protection over artwork; studio message fills stay opaque.
		"--color-user-bubble": translucent(
			glass ? sceneBase : surfaces.input,
			glass ? Math.max(74, sceneProtection.opacity) : 100,
		),
		"--color-reading-surface": translucent(surfaces.code, readingOpacity),
		"--color-reading-surface-header": mixSkinColor(surfaces.code, palette.text, dark ? 0.04 : 0.025),
		"--color-reading-surface-border": skinColorWithAlpha(palette.text, dark ? 0.14 : 0.12),
		"--color-composer": translucent(surfaces.composer, sceneProtection.opacity),
		"--color-code-block": translucent(surfaces.code, readingOpacity),
		"--color-code-block-header": mixSkinColor(surfaces.code, palette.text, dark ? 0.04 : 0.025),
		"--color-code-block-border": "var(--color-reading-surface-border)",
		"--color-selection": skinColorWithAlpha(palette.accent, dark ? 0.3 : 0.24),
		"--color-scrollbar-thumb": skinColorWithAlpha(palette.text, dark ? 0.3 : 0.22),
		"--color-link": palette.accent,
		"--color-tooltip": palette.surface,
		"--color-tooltip-foreground": palette.text,
		// Selection is an interaction surface above the common scene, like the composer.
		"--color-sidebar-active": translucent(windowScene ? sceneBacking : palette.surface, windowScene ? 64 : 100),
		"--color-statusbar": artworkWorkspace ? artworkWorkspaceSurface : chromeSurface(surfaces.statusbar),
		"--color-statusbar-foreground": mutedText,
		"--font-sans": typography.sans,
		"--font-mono": typography.mono,
		"--radius-sm": shape.sm,
		"--radius-control": shape.control,
		// A 999px radius retains the pill silhouette even when labels wrap to multiple lines.
		"--radius-choice": choiceShape === "pill" ? "999px" : shape.control,
		"--radius-reading-surface": shape.panel,
		"--radius-panel": shape.panel,
		"--shadow-reading-surface": readingShadow,
		"--shadow-floating": floatingShadow,
		// Choice controls use a 1px offset / 2px blur; flat skins remove this elevation entirely.
		"--shadow-choice": elevation === "flat" ? "none" : `0 1px 2px ${shadow}`,
		// A 4% press compression is disabled by authored motion:none; system reduced motion wins in CSS.
		"--choice-press-scale": manifest.presentation.motion === "none" ? "1" : "0.96",
		"--shadow-glass-edge": glass ? `inset 0 1px 0 ${edge}` : "none",
		// Static, viewport-bounded filters keep glass independent of transcript row count.
		"--glass-filter": sceneFilter,
		"--glass-chrome-filter": windowScene ? sceneFilter : "none",
		// Floating content overlaps text and needs its own 18px frost, independent of scene visibility.
		"--glass-floating-filter": systemMaterial ? "blur(18px) saturate(110%)" : "none",
		// A 24px frost obscures transcript glyphs behind the more transparent composer;
		// 110% saturation retains the skin hue without increasing foreground opacity.
		"--glass-composer-filter": systemMaterial ? "blur(24px) saturate(110%)" : "none",
		...ansiColors(dark),
	};
	return variables;
}

function resolveArtwork(
	artwork: SkinArtwork | null,
	canvas: string,
	assetUrl: (asset: string) => string,
	expression: SkinExpression,
	forceOpaque: boolean,
	override: SkinSceneOverride,
): ResolvedSkinArtwork | null {
	// Reduced transparency is also a compositor preference: do not leave hidden images or
	// ambient video decoding behind the fully opaque reading and chrome surfaces.
	if (artwork === null || forceOpaque) return null;
	return {
		scope: override.scope ?? artwork.scope ?? "window",
		treatment: override.treatment ?? artwork.treatment ?? SKIN_TREATMENTS.glass,
		layers: artwork.layers ?? [],
		mask: artwork.mask ?? null,
		canvas,
		mediaUrl: artwork.media === null ? null : assetUrl(artwork.media),
		posterUrl: artwork.poster === null ? null : assetUrl(artwork.poster),
		gradient: artwork.gradient,
		opacity: artwork.opacity,
		// Authored edge shading follows the same restraint as the scene material, never a second fixed veil.
		washOpacity: 1 - SKIN_SCENE_VISIBILITY[expression] / 100,
		blur: artwork.blur,
		brightness: artwork.brightness,
		contrast: artwork.contrast,
		saturation: artwork.saturation,
		fit: artwork.fit,
		position: artwork.position,
		wash: artwork.wash,
		video: artwork.media !== null && isSkinVideoAsset(artwork.media),
	};
}

export function resolveSkin(
	manifest: SkinManifest,
	expression: SkinExpression,
	assetUrl: (asset: string) => string,
	forceOpaque = false,
	override: SkinSceneOverride = {},
): ResolvedSkin {
	const resolveMode = (mode: SkinMode, appearance: SkinAppearanceMode): ResolvedSkinMode => {
		const { palette } = mode;
		// Omitted surface roles reuse validated source colors:
		// blending unrelated hues can lose contrast even when both endpoints pass AA.
		const surfaces: ResolvedSkinMode["surfaces"] = {
			sidebar: mode.surfaces?.sidebar ?? (mode.artwork === null ? palette.canvas : palette.surface),
			header:
				mode.surfaces?.header ?? mode.surfaces?.sidebar ?? (mode.artwork === null ? palette.canvas : palette.surface),
			statusbar:
				mode.surfaces?.statusbar ??
				mode.surfaces?.sidebar ??
				(mode.artwork === null ? palette.canvas : palette.surface),
			raised: mode.surfaces?.raised ?? palette.surface,
			input: mode.surfaces?.input ?? palette.canvas,
			code: mode.surfaces?.code ?? palette.canvas,
			composer: mode.surfaces?.composer ?? palette.surface,
			popover: mode.surfaces?.popover ?? mode.surfaces?.raised ?? palette.surface,
		};
		const artwork = resolveArtwork(
			mode.artwork,
			palette.canvas,
			assetUrl,
			expression,
			forceOpaque || manifest.presentation.material === "solid",
			override,
		);
		const mutedText = readableSkinColor(
			// High scene visibility needs a near-primary secondary foreground: retain 92% of its ink.
			mixSkinColor(palette.surface, palette.text, artwork?.scope === "window" ? 0.92 : 0.64),
			[palette.surface, palette.canvas, ...Object.values(surfaces)],
			palette.text,
		);
		return {
			appearance,
			palette,
			surfaces,
			vars: resolveVariables(mode, surfaces, mutedText, appearance, expression, manifest, forceOpaque, artwork),
			artwork,
		};
	};
	return manifest.kind === "art"
		? { manifest, kind: "art", mode: resolveMode(manifest.mode, manifest.appearance), forceOpaque }
		: {
				manifest,
				kind: "studio",
				modes: { light: resolveMode(manifest.modes.light, "light"), dark: resolveMode(manifest.modes.dark, "dark") },
				forceOpaque,
			};
}
