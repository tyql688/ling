# Skin Manifest

Ling loads custom skins from `~/.ling/skins/<id>/skin.json`. The directory name and manifest `id` must match. Schema 3 distinguishes a fixed artwork design from a studio's light/dark pair.

## Art example

An art skin has one `mode` and a fixed `appearance`. Navigation, conversation, composer, menus, code, and terminal share that appearance regardless of the saved studio preference. This example uses a local image; put the file in place before saving the manifest.

```json
{
	"schemaVersion": 3,
	"kind": "art",
	"appearance": "dark",
	"id": "quiet-forest",
	"meta": {
		"name": "Quiet Forest",
		"description": "Evergreen glass with restrained amber details",
		"author": "Your name",
		"license": "Personal use only"
	},
	"activate": true,
	"mode": {
		"palette": {
			"canvas": "#0d1210",
			"surface": "#18201c",
			"text": "#f0f4f1",
			"accent": "#6fc49e",
			"secondary": "#d6a15c"
		},
		"surfaces": {
			"code": "#101813",
			"composer": "#18201c",
			"popover": "#202b24"
		},
		"artwork": {
			"scope": "conversation",
			"treatment": { "kind": "dither", "cellSize": 1.5, "levels": 4, "strength": 0.85 },
			"media": "assets/forest.webp",
			"poster": null,
			"gradient": null,
			"opacity": 1,
			"brightness": 1,
			"contrast": 1,
			"saturation": 1,
			"blur": 0,
			"fit": "cover",
			"position": "70% center",
			"wash": null
		}
	},
	"presentation": {
		"shape": "native",
		"material": "system",
		"elevation": "soft",
		"motion": "subtle",
		"codeTheme": "vitesse",
		"typography": "system"
	}
}
```

## Studio example

A studio has two independently authored modes. It follows the saved light, dark, or system preference. Use colors or gradients for studio surfaces; photo and video designs use `kind: art`.

```json
{
	"schemaVersion": 3,
	"kind": "studio",
	"id": "forest-studio",
	"meta": {
		"name": "Forest Studio",
		"description": "Quiet evergreen materials for day and night",
		"author": "Your name",
		"license": "Personal use only"
	},
	"activate": true,
	"modes": {
		"light": {
			"palette": {
				"canvas": "#edf1ed",
				"surface": "#fbfcfa",
				"text": "#1d241f",
				"accent": "#276b4f",
				"secondary": "#8a5b24"
			},
			"artwork": null
		},
		"dark": {
			"palette": {
				"canvas": "#0d1210",
				"surface": "#18201c",
				"text": "#f0f4f1",
				"accent": "#6fc49e",
				"secondary": "#d6a15c"
			},
			"artwork": null
		}
	},
	"presentation": {
		"shape": "native",
		"material": "system",
		"elevation": "flat",
		"motion": "subtle",
		"codeTheme": "vitesse",
		"typography": "system"
	}
}
```

Every object is strict: unknown fields are errors. All shown fields except `surfaces`, `presentation.elevation`, `artwork.scope`, and `artwork.treatment` are required; the original artwork fields use explicit `null` for absent options. `primaryAction`, `choice`, `presentation.choiceShape`, `artwork.layers`, and `artwork.mask` are also optional. Art requires non-null artwork. Do not add `modes` to art, `mode` or `appearance` to studio, or obsolete `sceneInk` to either kind. These optional schema 3 extensions do not require rewriting existing packages.

## Identity and metadata

| Field              | Rule                                                                                   |
| ------------------ | -------------------------------------------------------------------------------------- |
| `schemaVersion`    | Exactly `3` for new packages                                                           |
| `kind`             | `art` or `studio`                                                                      |
| `appearance`       | Art only: `light` or `dark`, chosen to match its authored palette                      |
| `id`               | Lowercase letters, digits, and hyphens; 1–64 characters; no leading or trailing hyphen |
| `meta.name`        | 1–100 characters                                                                       |
| `meta.description` | 1–300 characters                                                                       |
| `meta.author`      | 1–100 characters                                                                       |
| `meta.license`     | 1–120 characters; accurate SPDX identifier or usage basis                              |
| `activate`         | Boolean; `true` selects the package when it changes during live editing                |

Metadata cannot contain control characters. A manifest is limited to 128 KiB; discovery accepts at most 100 packages. Replace the example author and license with accurate provenance for your work and assets.

## Palette and surfaces

Every mode has exactly five six-digit hex palette colors:

| Color       | Role                                                                        |
| ----------- | --------------------------------------------------------------------------- |
| `canvas`    | Window background; default source for art-free sidebar, input, and code     |
| `surface`   | Conversation tint; default source for artwork sidebar, raised, and composer |
| `text`      | Primary foreground throughout the design                                    |
| `accent`    | Sparse links, cursor, selection, and active-detail emphasis                 |
| `secondary` | Inline code, code strings, important callouts, and supporting identity      |

Text, accent, and secondary must each reach 4.5:1 contrast against canvas and surface. Ling derives borders, muted text, hover and status states, Git/diff colors, terminal ANSI colors, and component tokens. Primary actions and selected choices have the optional color pairs described below; other derived tokens cannot be overridden individually.

Optional `surfaces` accepts any of these six-digit hex colors:

| Role        | Used for                                                     |
| ----------- | ------------------------------------------------------------ |
| `sidebar`   | Navigation; default source for header and status bar         |
| `header`    | Window titlebar; inherits sidebar unless authored            |
| `statusbar` | Bottom window status strip; inherits sidebar unless authored |
| `raised`    | Raised cards and editor widgets; default source for popovers |
| `input`     | Form fields, select triggers, and studio user messages       |
| `code`      | Code blocks, Monaco, diff, and terminal                      |
| `composer`  | Welcome and conversation composers                           |
| `popover`   | Dialogs and floating menus                                   |

Every authored surface must reach 4.5:1 contrast with all three palette foregrounds. Omitted roles use validated palette source colors. These are solid colors, never alpha values or CSS paints; Ling owns the material. Palette validation alone cannot guarantee readability over every artwork pixel.

Optional `primaryAction` takes `background` and `foreground`, each six-digit hex with at least 4.5:1 contrast. Omitting it uses palette text on palette surface as the primary button pair. Ling derives the hover fill without fading labels.

## Choices and model configuration

Optional `choice` takes `background` and `foreground`, each six-digit hex with at least 4.5:1 contrast against the other. It styles selected choices independently of primary action buttons. Omission inherits `primaryAction`, or palette text on palette surface when both pairs are absent. Place it in an art package's `mode`, or separately in each studio mode. Unselected choices use `surfaces.raised` and derived readable text; Ling derives an opaque hover fill and uses the palette accent for the keyboard focus outline. Icons and checkmarks inherit the same foreground as the label.

Optional `presentation.choiceShape` accepts `pill` or `control`. `pill` retains rounded ends; `control` follows the general `presentation.shape` control radius. If omitted, sharp skins use the control radius while native and soft skins retain pills. Choice shadows follow `presentation.elevation`; `flat` removes them. `presentation.motion: none` suppresses press compression as well as transitions, and system reduced motion also suppresses it.

For example, merge this selected-choice pair into a mode and this shape into the existing presentation object. These are fragments, not complete manifests:

```json
{
	"choice": { "background": "#276b4f", "foreground": "#ffffff" }
}
```

```json
{
	"choiceShape": "control"
}
```

The model creation, editing, and configuration views share the normal skin roles:

| Interface element | Authored fields |
| --- | --- |
| Input types, copy scope, and effective/saved configuration choices | `choice`, `surfaces.raised`, `presentation.choiceShape`, `presentation.elevation`, `presentation.motion` |
| Add, save, and other primary actions | `primaryAction` |
| Model search, reference picker, and editable fields | `surfaces.input` |
| Model editor and configuration dialogs | `surfaces.popover`, `presentation.shape`, `presentation.material` |
| Configuration JSON and save preview | `surfaces.code`, `presentation.shape`, `presentation.elevation`, `presentation.typography` |
| Field sources, hints, and status labels | Palette text, accent, secondary, and derived status colors |

Changing these fields affects presentation only. It does not change model capabilities, copied fields, saved configuration, or catalog replacement behavior. Switch away and back, then reload to check that both the choices and JSON previews follow the new skin without stale values.

## Artwork

Studio modes may use `artwork: null` or a gradient-only artwork object. Art requires an artwork object, using media or a gradient. These base artwork fields are required:

| Field        | Allowed values                                                                         |
| ------------ | -------------------------------------------------------------------------------------- |
| `media`      | `null` or safe path below `assets/` ending in png, jpg, jpeg, webp, avif, mp4, or webm |
| `poster`     | An image path below `assets/` for mp4/webm media; must be `null` otherwise             |
| `gradient`   | `null`, six/eight-digit hex paint, or bounded linear/radial/conic gradient layers      |
| `opacity`    | 0–1; blends media into palette canvas                                                  |
| `brightness` | 0–2; `1` preserves source brightness                                                   |
| `contrast`   | 0–2; `1` preserves source contrast                                                     |
| `saturation` | 0–2; `1` preserves source saturation                                                   |
| `blur`       | 0–64 pixels; changes source artwork, independently of viewport frost                   |
| `fit`        | `cover`, `contain`, `fill`, or `tile`; video cannot tile                               |
| `position`   | Short CSS background position, for example `70% center`                                |
| `wash`       | Same paint rules as gradient; optional shading above media                             |

Artwork needs media or gradient. Paints accept comma-separated standard or repeating gradient layers but reject URLs, variables, image functions, declarations, braces, and backslashes. Asset paths are at most 240 characters, allow at most three nested directories below `assets/`, and cannot escape the package through paths or symbolic links. Images are limited to 32 MiB and videos to 256 MiB. Video requires an image poster and applies focal position as object position.

## Scope, treatment, and custom composition

These optional artwork fields extend an existing design without choosing another template:

| Field       | Contract and default                                                                       |
| ----------- | ------------------------------------------------------------------------------------------ |
| `scope`     | `window` (default) or `conversation`                                                       |
| `treatment` | Defaults to `{ "kind": "glass" }`; see variants below                                      |
| `layers`    | Zero to eight paint layers in back-to-front order; defaults to `[]`                        |
| `mask`      | An optional safe alpha-mask paint on the complete composition; omitted means fully visible |

`window` paints behind the complete window. `conversation` paints behind the transcript and its composer, including the welcome view; it does not scroll with messages. Navigation, title/status chrome, Settings, editors, diff, terminal, and menus use coordinated solid surface colors. Author `surfaces.sidebar`, `header`, and `statusbar` when they should differ.

Treatment is a strict discriminated object:

```json
{ "kind": "glass", "blur": 10 }
```

Glass `blur` is optional, 0–64 CSS pixels; omission follows Balanced 12px / Immersive 4px. A custom value fixes frost strength while expression continues to adjust tint. Source `artwork.blur` remains independent.

```json
{ "kind": "dither", "cellSize": 1.5, "levels": 4, "strength": 0.85 }
```

Dither appears as “Pixel dithering” in Background effect. It requires `cellSize` (1–6 CSS pixels), integer `levels` (2–16 quantization intervals per RGB channel), and `strength` (0–1). The 4×4 Bayer threshold tile creates ordered square cells whose density follows the image tones. It applies to media and gradients, including playing video. It never changes text or control pixels. `strength: 0` preserves the original; `1` uses the full quantized result. The built-in choice starts at 1.5px, four intervals, full strength.

```json
{ "kind": "clear" }
```

Clear preserves the source treatment without viewport frost or dithering. Expression still controls the reading tint; local composer and menu protection remains.

```json
{ "kind": "paper", "strength": 0.65 }
```

The static texture variants require `strength` (0–1): `paper` adds fine seeded grain, `scanlines` adds horizontal light/shade bands, and `linen` crosses fine threads. They use soft-light blending to retain the source colors. Their built-in strengths are 0.65, 0.5, and 0.6 respectively. Zero removes the texture; one uses its full pattern. They apply to gradients, still images, and playing video, stay still under reduced motion, and never alter text or control pixels.

A stored `halftone` value normalizes to `dither` with the default cell size and levels, preserving its strength and artwork scope. New packages use one of the six current effects.

Rendering order is palette canvas → source gradient → image/video, with the authored source opacity and tone filters → ordered dithering or static texture if selected → legacy `wash` → `layers` in array order → overall alpha `mask` → viewport reading tint/frost → opaque text and locally protected controls. Paint layers do not inherit source opacity or expression-dependent wash strength. They are composited within an isolated artwork group, so blend modes cannot recolor UI content.

Each layer requires a unique stable `id` (same lowercase kebab-case rules as the skin id), `paint`, `opacity` (0–1), and `blend` (`normal`, `multiply`, `screen`, `overlay`, `soft-light`, `color`, or `luminosity`). Optional `mask` affects only that layer. The complete composition's mask reveals palette canvas. Masking uses alpha, not luminance: both opaque black and opaque white reveal; zero alpha conceals. Use an opaque/transparent gradient for a masked edge.

For example, this independent composition keeps a dark canvas, adds a restrained violet corner, and shades both horizontal edges. It adds no downward fade:

```json
{
	"layers": [
		{
			"id": "violet-glow",
			"paint": "radial-gradient(ellipse at 90% 15%, #9365ff70, #9365ff00 65%)",
			"opacity": 0.3,
			"blend": "screen"
		},
		{
			"id": "edge-shading",
			"paint": "linear-gradient(90deg, #0d102b80, #0d102b00 24%, #0d102b00 80%, #0d102b50)",
			"opacity": 0.45,
			"blend": "normal"
		}
	]
}
```

Only when a user requests a bottom fade, add a layer such as `{ "id": "bottom-fade", "paint": "linear-gradient(to bottom, #ffffff00 55%, #ffffffff)", "opacity": 0.7, "blend": "normal" }`. Choose its final color to fit the authored palette; white is not a system default. A fade can instead reveal the canvas with `"mask": "linear-gradient(to bottom, #ffffffff 65%, #ffffff00)"`. These examples are artwork fragments, not complete manifests. Other compositions use the same ordered paints, blend modes, opacity, and masks; no gallery preset limits their combination.

Settings exposes scope, seven texture previews, dither dot size, and static texture strength as per-skin overrides. These do not rewrite skin.json or remove its layers/mask. “Use authored design” clears that skin's overrides and reveals the latest package defaults, including custom dither parameters, glass blur, or texture strength. Overrides survive switching skins and restarting. Inspect manifest changes after resetting overrides when an existing local choice intentionally takes precedence.

## Presentation and materials

| Axis | Values | Meaning |
| --- | --- | --- |
| `shape` | `native`, `sharp`, `soft` | Coordinated radius scale for sheets, controls, composer, and reading surfaces |
| `choiceShape` | `pill`, `control` | Optional override for choice controls; omitted sharp skins follow the control radius, other shapes keep pills |
| `material` | `system`, `solid` | System uses artwork or native glass; solid keeps surfaces opaque and suppresses hidden artwork |
| `elevation` | `flat`, `soft`, `layered` | Optional, defaults to soft; reading edges and floating shadows |
| `motion` | `none`, `subtle`, `ambient` | None disables transitions; subtle uses static art; ambient permits video |
| `codeTheme` | `neutral`, `github`, `vitesse`, `catppuccin` | Coordinated Shiki, Pierre, and Monaco syntax treatment |
| `typography` | `system`, `editorial`, `technical` | System-font stacks for UI; Markdown keeps native prose fonts and CJK fallbacks |

Expression is user-owned. With artwork, Balanced transmits 60%; Immersive transmits 90%: tint opacity equals 100% minus visibility. Glass adds 12px/4px frost unless `treatment.blur` is authored. Dither and clear keep the scene crisp. Window scope shares the scene across regions; conversation scope keeps the same palette with solid surrounding surfaces. Opening or closing a conversation never changes the chosen material. Optional legacy wash uses 40%/10% strength, while artwork tone, opacity, and explicit paint layers remain authored values. No mode adds a bottom-white gradient automatically.

The composer uses a separate 24px frost with 110% saturation and a tint starting at 68%. Ling increases protection as needed for primary text over black and white backdrops, then derives readable muted, accent, and status ink. Art-free native glass starts at 88% because filtering a transparent window retains some sharp transcript alpha. Text, placeholders, and controls stay opaque; only the backing is translucent. Daily usage, user messages, and reading surfaces have their own protection independent of expression. Code, editors, and menus use stronger material, with an independent 18px floating frost. Glass belongs to bounded viewports and floating surfaces, never every transcript row.

Inline code uses secondary ink on a protected chip; linked code uses accent. Ling checks both against extreme backdrops and strengthens protection as needed. Tables use horizontal rules and a thin artwork wash. Conversation fences use a protected code surface and the same authored syntax appearance, with no floating shadow or separate header surface. Dense panels restore foregrounds tuned for their stronger backing. Text has no shadows; inspect real paragraphs, links, tables, code, and controls instead of relying on solid-color contrast alone.

Without artwork, system material reveals native desktop glass across navigation, chrome, empty workspace, and conversation. A saved slider controls their tint without fading text or adding a second viewport blur; at 100%, Ling's tint disappears and native frost remains. Browsers without native material keep these regions opaque. The composer retains its local frosted backing. The native slider is inactive while artwork is selected and restores when switching back. Solid material and reduced transparency make all surfaces opaque and suppress artwork and blur. Reduced motion uses the video poster; `motion: none` also disables interface transitions.

## Legacy packages

Schema 2 packages are accepted at the read boundary and normalized to schema 3 without rewriting files. Packages without photo/video media remain studio pairs. A package with media becomes one art design: use its only media mode when just one has media; otherwise honor its authored `sceneInk` polarity if present, or preserve the existing dark design. Obsolete scene ink is removed after selecting the palette. To choose a different fixed result, save an explicit schema 3 art package. Do not author schema 2 for new skins.

## Package checks

1. Confirm the directory name and manifest id match, and every asset is a regular file within the package.
2. Resolve every diagnostic under Settings → Appearance → Custom skins.
3. Inspect the fixed art appearance or both studio modes in the actual workspace.
4. Inspect composer draft/focus/menus, user messages, daily usage, inline code and links, tables, fences, Settings, model choice states and configuration JSON, Monaco editor/diff, and terminal at wide and narrow sizes.
5. Switch skins, change the studio preference, and reload; art must retain its fixed appearance and switching back must restore the saved studio choice.
6. Verify reduced motion and reduced transparency; a video design must display its poster when playback is suppressed.
7. Verify the authored scope, treatment, and any layers or masks. Check saved overrides and use “Use authored design” when intentionally restoring manifest defaults. Exercise additional variants only when they are part of the requested work.

These are live checks when interface access is available. File validation alone does not establish visual readability; report any unverified states explicitly.
