import { SKIN_SCHEMA_VERSION } from "@ling/contracts/skins";
import { RENDERER_PREFERENCE_KEYS, writeRendererPreference } from "@renderer/lib/preferences/renderer-preferences";
import type { ResolvedSkin, ResolvedSkinMode, SkinExpression } from "./resolve-skin";

export const APPEARANCE_CHANGED_EVENT = "ling:appearance-changed";

let appliedKeys: string[] = [];

export function applySkinMode(resolved: ResolvedSkin, mode: ResolvedSkinMode, expression: SkinExpression): void {
	const root = document.documentElement;
	const style = root.style;
	root.classList.toggle("dark", mode.appearance === "dark");
	for (const key of appliedKeys) {
		if (!(key in mode.vars)) style.removeProperty(key);
	}
	for (const [key, value] of Object.entries(mode.vars)) {
		style.setProperty(key, value);
	}
	appliedKeys = Object.keys(mode.vars);
	root.dataset.skinId = resolved.manifest.id;
	root.dataset.skinKind = resolved.kind;
	root.dataset.skinAppearance = mode.appearance;
	root.dataset.skinExpression = expression;
	root.dataset.skinMaterial = resolved.manifest.presentation.material;
	root.dataset.skinMotion = resolved.manifest.presentation.motion;
	root.dataset.skinCodeTheme = resolved.manifest.presentation.codeTheme;
	root.dataset.skinScope = mode.artwork?.scope ?? "window";
	root.dataset.skinTreatment = mode.artwork?.treatment.kind ?? "clear";
	if (mode.artwork === null) delete root.dataset.skinBackdrop;
	else root.dataset.skinBackdrop = "true";
	window.dispatchEvent(new CustomEvent(APPEARANCE_CHANGED_EVENT));
}

export function writeSkinBootCache(resolved: ResolvedSkin): void {
	// Preserve the last normal snapshot; the boot script separately honors reduced transparency.
	if (resolved.forceOpaque) return;
	const snapshot = (mode: ResolvedSkinMode) => ({
		vars: mode.vars,
		artwork: mode.artwork !== null,
		scope: mode.artwork?.scope,
		treatment: mode.artwork?.treatment.kind,
	});
	try {
		writeRendererPreference(
			RENDERER_PREFERENCE_KEYS.skinCache,
			JSON.stringify({
				// Material policy revisions invalidate derived tokens independently of the manifest format.
				materialVersion: 12,
				version: SKIN_SCHEMA_VERSION,
				id: resolved.manifest.id,
				material: resolved.manifest.presentation.material,
				motion: resolved.manifest.presentation.motion,
				codeTheme: resolved.manifest.presentation.codeTheme,
				...(resolved.kind === "art"
					? { kind: "art", appearance: resolved.mode.appearance, mode: snapshot(resolved.mode) }
					: { kind: "studio", modes: { light: snapshot(resolved.modes.light), dark: snapshot(resolved.modes.dark) } }),
			}),
		);
	} catch {
		// The boot cache is only a first-paint hint; the authoritative manifest still applies after mount.
	}
}
