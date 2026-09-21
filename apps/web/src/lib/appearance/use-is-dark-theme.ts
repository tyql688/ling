import { APPEARANCE_CHANGED_EVENT } from "@renderer/lib/appearance/skins/apply-skin";
import { useEffect, useState } from "react";

/** Reads the effective class applied with the skin palette; consumers such as Monaco need the
 * resolved light/dark value, not the user's `system` preference. */
export function useIsDarkTheme(): boolean {
	const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
	useEffect(() => {
		const update = () => setDark(document.documentElement.classList.contains("dark"));
		window.addEventListener(APPEARANCE_CHANGED_EVENT, update);
		return () => window.removeEventListener(APPEARANCE_CHANGED_EVENT, update);
	}, []);
	return dark;
}
