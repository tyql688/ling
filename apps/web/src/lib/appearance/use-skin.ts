import { useDomainApi } from "@renderer/lib/host-api-context";
import { skinMediaUrl, type SkinManifest, type UserSkinsSnapshot } from "@ling/contracts/skins";
import { errorMessage } from "@ling/contracts/ling-error";
import {
	activeSkinAppearanceAtom,
	skinExpressionAtom,
	skinSceneOverridesAtom,
	skinLoadErrorAtom,
	skinPreferenceAtom,
	userSkinsAtom,
} from "@renderer/lib/appearance/skin-state";
import { applySkinMode, writeSkinBootCache } from "@renderer/lib/appearance/skins/apply-skin";
import { useTheme, type ThemeController } from "@renderer/lib/appearance/use-theme";
import { BUILTIN_SKINS, DEFAULT_SKIN_MANIFEST } from "@renderer/lib/appearance/skins/builtin-skins";
import {
	resolveSkin,
	selectResolvedSkinMode,
	type ResolvedSkin,
	type ResolvedSkinArtwork,
} from "@renderer/lib/appearance/skins/resolve-skin";
import { useAtom, useSetAtom } from "jotai";
import { MotionGlobalConfig } from "motion/react";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";

const reducedTransparency = window.matchMedia("(prefers-reduced-transparency: reduce)");

export function useReducedTransparency(): boolean {
	return useSyncExternalStore(
		(onChange) => {
			reducedTransparency.addEventListener("change", onChange);
			return () => reducedTransparency.removeEventListener("change", onChange);
		},
		() => reducedTransparency.matches,
	);
}

interface SelectedManifest {
	manifest: SkinManifest;
	assetUrl(asset: string): string;
}

interface ActiveSkinBackdrop {
	layer: ResolvedSkinArtwork | null;
	motion: SkinManifest["presentation"]["motion"];
	themeController: ThemeController;
}

function defaultManifest(): SelectedManifest {
	return {
		manifest: DEFAULT_SKIN_MANIFEST,
		assetUrl: (asset) => {
			throw new Error(`The default skin has no artwork asset ${asset}`);
		},
	};
}

function selectManifest(preference: string, userSkins: UserSkinsSnapshot | null): SelectedManifest | null {
	if (preference.startsWith("builtin:")) {
		const skin = BUILTIN_SKINS.find((entry) => entry.id === preference.slice("builtin:".length));
		if (skin) return { manifest: skin.manifest, assetUrl: skin.assetUrl };
	}
	if (preference.startsWith("custom:")) {
		// Preserve the synchronous boot-cache paint until the authoritative package listing arrives.
		// Falling back here would flash the stock palette and turn a failed read into a false default.
		if (userSkins === null) return null;
		const id = preference.slice("custom:".length);
		const skin = userSkins.skins.find((entry) => entry.id === id);
		if (skin?.manifest && skin.error === null) {
			return {
				manifest: skin.manifest,
				assetUrl: (asset) => skinMediaUrl(skin.id, asset, skin.revision),
			};
		}
	}
	return defaultManifest();
}

export function useSkin(workspace: boolean): ActiveSkinBackdrop {
	const hostUiApi = useDomainApi("ui");
	const hostSkinsApi = useDomainApi("skins");
	const hostThemeApi = useDomainApi("theme");

	const theme = useTheme();
	const [preference, setPreference] = useAtom(skinPreferenceAtom);
	const [expression] = useAtom(skinExpressionAtom);
	const [sceneOverrides] = useAtom(skinSceneOverridesAtom);
	const sceneOverride = sceneOverrides[preference];
	const [userSkins, setUserSkins] = useAtom(userSkinsAtom);
	const setLoadError = useSetAtom(skinLoadErrorAtom);
	const setActiveAppearance = useSetAtom(activeSkinAppearanceAtom);
	const previousRef = useRef<UserSkinsSnapshot | null>(null);
	const forceOpaque = useReducedTransparency();

	useEffect(() => {
		// The OS preference can change while the window is open. Keep the renderer material
		// class synchronized instead of relying only on the pre-paint bootstrap decision.
		document.documentElement.classList.toggle("vibrancy", hostUiApi.translucent && !forceOpaque);
	}, [hostUiApi, forceOpaque]);

	useEffect(() => {
		let cancelled = false;
		let changedSinceRequest = false;
		void hostSkinsApi
			.list()
			.then((snapshot) => {
				if (cancelled || changedSinceRequest) return;
				previousRef.current = snapshot;
				setLoadError(snapshot.error);
				setUserSkins(snapshot);
			})
			.catch((error: unknown) => {
				if (!cancelled && !changedSinceRequest) setLoadError(errorMessage(error));
			});
		const unsubscribe = hostSkinsApi.onChanged((snapshot) => {
			changedSinceRequest = true;
			const previous = previousRef.current;
			previousRef.current = snapshot;
			setLoadError(snapshot.error);
			setUserSkins(snapshot);
			if (!previous) return;
			const previousRevisions = new Map(previous.skins.map((skin) => [skin.id, skin.revision]));
			const activated = snapshot.skins.findLast(
				(skin) =>
					skin.manifest?.activate === true && skin.error === null && previousRevisions.get(skin.id) !== skin.revision,
			);
			if (activated) setPreference(`custom:${activated.id}`);
		});
		return () => {
			cancelled = true;
			unsubscribe();
		};
	}, [hostSkinsApi, setLoadError, setPreference, setUserSkins]);

	// Resolution may temporarily use the stock appearance, but only an explicit choice
	// or deletion changes the saved preference. Repairing the package restores it.
	const selected = useMemo(() => selectManifest(preference, userSkins), [preference, userSkins]);
	const resolved: ResolvedSkin | null = useMemo(
		() =>
			selected === null
				? null
				: resolveSkin(selected.manifest, expression, selected.assetUrl, forceOpaque, sceneOverride),
		[expression, forceOpaque, sceneOverride, selected],
	);
	const activeMode = resolved === null ? null : selectResolvedSkinMode(resolved, theme.appearance);
	const shellTheme = resolved?.kind === "art" ? resolved.mode.appearance : theme.preference;
	const themeController: ThemeController = {
		preference: theme.preference,
		setPreference: theme.setPreference,
		studioAppearance: theme.appearance,
		switchable: resolved?.kind === "studio",
	};
	const chromeForeground =
		activeMode === null ? null : workspace ? activeMode.vars["--color-scene-text"] : activeMode.palette.text;
	useEffect(() => {
		if (chromeForeground === null) return;
		if (chromeForeground === undefined) throw new Error("The resolved skin is missing its scene foreground");
		void hostThemeApi.set(shellTheme, chromeForeground);
	}, [hostThemeApi, chromeForeground, shellTheme]);

	useEffect(() => {
		if (resolved === null || activeMode === null) return;
		// One renderer owns Motion; the skin's explicit off setting also covers layout and imperative animations.
		MotionGlobalConfig.skipAnimations = resolved.manifest.presentation.motion === "none";
		applySkinMode(resolved, activeMode, expression);
		writeSkinBootCache(resolved);
		setActiveAppearance({
			appearance: activeMode.appearance,
			motion: resolved.manifest.presentation.motion,
			codeTheme: resolved.manifest.presentation.codeTheme,
			palette: activeMode.palette,
			codeSurface: activeMode.surfaces.code,
			popoverSurface: activeMode.surfaces.popover,
		});
	}, [activeMode, expression, resolved, setActiveAppearance]);

	if (resolved === null || activeMode === null) return { layer: null, motion: "subtle", themeController };
	return { layer: activeMode.artwork, motion: resolved.manifest.presentation.motion, themeController };
}
