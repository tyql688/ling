import type { SkinCodeTheme } from "@ling/contracts/skins";

interface CodePreviewThemePair {
	light: string;
	dark: string;
}

export const CODE_THEME_PAIRS: Record<SkinCodeTheme, CodePreviewThemePair> = {
	neutral: { light: "one-light", dark: "one-dark-pro" },
	github: { light: "github-light", dark: "github-dark" },
	vitesse: { light: "vitesse-light", dark: "vitesse-dark" },
	catppuccin: { light: "catppuccin-latte", dark: "catppuccin-mocha" },
};

interface CodePreviewSettings {
	showLineNumbers: boolean;
	wrapLongLines: boolean;
	/** Monospace stack for code blocks and inline code. */
	fontFamily: string;
	fontSizePx: number;
}

/**
 * Fixed product defaults for code highlighting; these are not persisted user settings.
 */
export const CODE_PREVIEW_DEFAULTS: CodePreviewSettings = {
	showLineNumbers: true,
	wrapLongLines: false,
	fontFamily: '"JetBrains Mono", "SF Mono", Menlo, Consolas, ui-monospace, monospace',
	fontSizePx: 12,
};
