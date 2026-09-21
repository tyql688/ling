import { sharedPreferenceAtom } from "@renderer/lib/user-state/state";

/** An empty preferred family uses the platform stack; symbol fallbacks cover prompt separators. */
export const terminalFontFamilyAtom = sharedPreferenceAtom("terminalFontFamily", "");
export const terminalFontSizeAtom = sharedPreferenceAtom("terminalFontSize", 13);
const TERMINAL_FONT_FALLBACK =
	'"Ling Powerline Symbols", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Symbols Nerd Font Mono", "Apple Symbols", "Segoe UI Symbol", "Noto Sans Symbols 2", monospace';
export interface TerminalTypography {
	fontFamily: string;
	fontSize: number;
}
export function terminalTypography(family: string, fontSize: number): TerminalTypography {
	return {
		fontFamily: family.trim() === "" ? TERMINAL_FONT_FALLBACK : `${family}, ${TERMINAL_FONT_FALLBACK}`,
		fontSize,
	};
}
