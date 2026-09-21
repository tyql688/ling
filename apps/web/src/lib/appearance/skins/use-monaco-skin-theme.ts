import { activeSkinAppearanceAtom } from "@renderer/lib/appearance/skin-state";
import { useIsDarkTheme } from "@renderer/lib/appearance/use-is-dark-theme";
import { useAtomValue } from "jotai";
import * as monaco from "monaco-editor";
import { useLayoutEffect } from "react";
import { mixSkinColor, readableSkinColor } from "./skin-color";

const TRANSPARENT_EDITOR_BACKGROUND = "#00000000";

function tokenColor(color: string): string {
	return color.slice(1);
}

export function useMonacoSkinTheme(): string {
	const isDark = useIsDarkTheme();
	const appearance = useAtomValue(activeSkinAppearanceAtom);
	const themeName = isDark ? "ling-skin-dark" : "ling-skin-light";

	useLayoutEffect(() => {
		const { palette, codeTheme, codeSurface, popoverSurface } = appearance;
		// Comments are text, not decoration: keep their quieter tint within AA on both editor materials.
		const muted = readableSkinColor(
			mixSkinColor(codeSurface, palette.text, 0.64),
			[codeSurface, popoverSurface],
			palette.text,
		);
		const keyword = codeTheme === "github" ? palette.secondary : palette.accent;
		const string = codeTheme === "vitesse" ? palette.accent : palette.secondary;
		const type = codeTheme === "catppuccin" ? palette.accent : mixSkinColor(palette.secondary, palette.text, 0.18);
		const line = mixSkinColor(codeSurface, palette.text, isDark ? 0.07 : 0.025);
		monaco.editor.defineTheme(themeName, {
			base: isDark ? "vs-dark" : "vs",
			inherit: true,
			rules: [
				{ token: "comment", foreground: tokenColor(muted), fontStyle: "italic" },
				{ token: "keyword", foreground: tokenColor(keyword) },
				{ token: "string", foreground: tokenColor(string) },
				{ token: "number", foreground: tokenColor(palette.accent) },
				{ token: "type", foreground: tokenColor(type) },
				{ token: "type.identifier", foreground: tokenColor(type) },
				{ token: "identifier", foreground: tokenColor(palette.text) },
				{ token: "delimiter", foreground: tokenColor(muted) },
			],
			colors: {
				// The React workbench surface owns the single material layer. Repainting these
				// Monaco planes with palette.surface made file and diff views fully opaque.
				"editor.background": TRANSPARENT_EDITOR_BACKGROUND,
				"editorGutter.background": TRANSPARENT_EDITOR_BACKGROUND,
				"editorStickyScroll.background": TRANSPARENT_EDITOR_BACKGROUND,
				"minimap.background": TRANSPARENT_EDITOR_BACKGROUND,
				"editor.foreground": palette.text,
				"editorLineNumber.foreground": muted,
				"editorLineNumber.activeForeground": palette.text,
				"editor.lineHighlightBackground": line,
				"editor.lineHighlightBorder": TRANSPARENT_EDITOR_BACKGROUND,
				"editor.selectionBackground": `${palette.accent}3d`,
				"editor.inactiveSelectionBackground": `${palette.accent}24`,
				"editorCursor.foreground": palette.accent,
				"editorIndentGuide.background1": `${palette.text}1a`,
				"editorIndentGuide.activeBackground1": `${palette.text}40`,
				"editorOverviewRuler.border": TRANSPARENT_EDITOR_BACKGROUND,
				"scrollbar.shadow": TRANSPARENT_EDITOR_BACKGROUND,
				"editorWidget.background": popoverSurface,
				"editorHoverWidget.background": popoverSurface,
				"editorSuggestWidget.background": popoverSurface,
				"diffEditor.border": `${palette.text}1a`,
				"diffEditor.diagonalFill": `${palette.text}12`,
				"diffEditor.unchangedRegionBackground": `${palette.text}08`,
				"diffEditor.insertedTextBackground": isDark ? "#40c97730" : "#087f3d24",
				"diffEditor.removedTextBackground": isDark ? "#ff676430" : "#d92d2a24",
				"diffEditor.insertedLineBackground": isDark ? "#40c97714" : "#087f3d0f",
				"diffEditor.removedLineBackground": isDark ? "#ff676414" : "#d92d2a0f",
			},
		});
		monaco.editor.setTheme(themeName);
	}, [appearance, isDark, themeName]);

	return themeName;
}
