import type { SkinMotion } from "@ling/contracts/skins";
import { createContext } from "react";
import type { ResolvedSkinArtwork } from "./resolve-skin";

/** The app owns selection; bounded conversation viewports consume the same resolved scene. */
export const SkinBackdropContext = createContext<{ layer: ResolvedSkinArtwork | null; motion: SkinMotion }>({
	layer: null,
	motion: "none",
});
