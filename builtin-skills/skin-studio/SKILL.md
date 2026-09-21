---
name: skin-studio
description: "Create, edit, or repair Ling appearance packages: palettes, local artwork, conversation or window backgrounds, textures, paint layers, and light/dark designs. Use when the user wants to change Ling's appearance or turn a visual reference into a skin."
---

# Skin Studio

Create a declarative Ling skin that expresses the user's design and remains readable during real work. Read [Skin manifest](references/skin-manifest.md) for the current schema, complete examples, asset limits, and presentation behavior before writing a package. Install Pi terminal theme packages through the `ling_plugins` tool or Settings → Plugins.

## Choose the design

- Use `kind: art` for one fixed light or dark appearance with local media or a gradient. Design the entire interface around that appearance; the saved studio theme preference must not invert it.
- Use `kind: studio` for independently authored light and dark modes. Studio artwork can use gradients; photo and video designs use the art kind.
- Choose `conversation` or `window` artwork scope, then `glass`, `dither`, `clear`, `paper`, `scanlines`, or `linen` treatment. These are independent choices. Coordinate solid navigation, settings, and reading surfaces when the artwork is confined to the conversation.
- Author a coherent palette and the required presentation choices. Add surface colors, primary action or selected-choice colors, layers, or masks only when they improve the requested design. Use `choice` and `presentation.choiceShape` to style model input types, copy scopes, and configuration view choices; read the reference's model configuration table for their related surfaces. Ling derives interaction colors and reading protection.
- Follow the user's reference deliberately. Preserve focal content across window sizes, keep accents restrained, and avoid adding fades, washes, vignettes, or an opposite appearance without a design reason.

The manifest and local assets are the skin boundary. Do not inject CSS, HTML, JavaScript, remote media URLs, arbitrary fonts, or component selectors. A skin changes appearance through supported fields; it does not register application UI or a Pi extension.

## Write and load the package

1. Inspect `~/.ling/skins/<id>/` before editing and preserve unrelated packages. The directory and manifest `id` must match. Use schema 3 for new work; read the reference's legacy section only when repairing an older package.
2. Prepare assets under `assets/` and record accurate authorship and usage rights. Use supported still images, or MP4/WebM video with an image poster. Animated GIF is unsupported.
3. Author the manifest from a complete example. Text, accent, and secondary must each meet 4.5:1 contrast against both palette backgrounds and every authored surface. Use the declared fields rather than trying to override Ling's protected materials.
4. Write assets first and `skin.json` last. Use `activate: true` when the user wants to preview or apply the design: Ling selects a valid changed package while running. Use `false` when creating or maintaining a package without changing the selection.
5. Inspect Settings → Appearance for diagnostics. Fix the reported field or asset. Saved per-skin scope and treatment overrides can hide changed defaults; use “Use authored design” when the user wants the manifest's design to replace those choices.

Deleting a custom skin through Settings removes its package directory. Keep edits and removals within the requested package.

## Verify the result

Complete the package checks in [Skin manifest](references/skin-manifest.md) for the requested design and its authored features. Inspect the actual interface with available UI tools; file validation alone does not establish readability. If UI access is unavailable, complete file and asset validation and identify the remaining live checks. Report the package path, design choices, diagnostics and states actually verified.
