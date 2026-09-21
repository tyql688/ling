import { DiffsWorkerPoolProvider } from "@renderer/components/diffs-worker-pool-provider";
import { File as DiffsFile, type FileContents } from "@pierre/diffs/react";
import { codeHighlightLanguage } from "@renderer/lib/code-highlighting/languages";
import { CODE_PREVIEW_DEFAULTS } from "@renderer/lib/preferences/code-preview";
import { type CSSProperties, useMemo } from "react";

// Font size/family: concrete px/stack values, because nesting var() into the Pierre shadow is unreliable.
const fontFamily = CODE_PREVIEW_DEFAULTS.fontFamily;
const fontSizePx = CODE_PREVIEW_DEFAULTS.fontSizePx;
const lineHeightPx = fontSizePx + 8;

const diffsStyle = {
	// The outer MarkdownCodeBlock owns the reading material. Repainting it inside Pierre would
	// composite the same alpha twice and make the code body look opaque beside a matching table.
	"--diffs-bg": "transparent",
	"--diffs-light-bg": "transparent",
	"--diffs-dark-bg": "transparent",
	"--diffs-font-family": fontFamily,
	"--diffs-font-size": `${fontSizePx}px`,
	"--diffs-line-height": `${lineHeightPx}px`,
	"--diffs-gap-block": "0px",
	fontFamily,
	fontSize: `${fontSizePx}px`,
	lineHeight: `${lineHeightPx}px`,
} as CSSProperties;

function getPierreFilename(language: string): string {
	return `preview.${language}`;
}

function hashCode(code: string): string {
	let hash = 5_381;
	for (let index = 0; index < code.length; index += 1) hash = (hash * 33) ^ code.charCodeAt(index);
	return (hash >>> 0).toString(36);
}

export function HighlightedMarkdownCode({
	code,
	language,
	showLineNumbers,
	theme,
	wrapLongLines,
}: {
	code: string;
	language: string;
	showLineNumbers: boolean;
	theme: { light: string; dark: string };
	wrapLongLines: boolean;
}) {
	const file = useMemo<FileContents>(() => {
		const filename = getPierreFilename(language);
		return {
			name: filename,
			contents: code,
			lang: codeHighlightLanguage(language),
			// Theme and font size both go into cacheKey: Pierre worker results are cached by key, so appearance changes need a new key.
			cacheKey: `u:${theme.light}:${theme.dark}:${fontSizePx}:${filename}:${language}:${code.length}:${hashCode(code)}`,
		};
	}, [code, language, theme.dark, theme.light]);

	const options = useMemo(
		() => ({
			disableFileHeader: true,
			disableLineNumbers: !showLineNumbers,
			overflow: wrapLongLines ? ("wrap" as const) : ("scroll" as const),
			theme,
			// Diff code blocks default to split two columns (deletion/addition side by side); single-column unified matches DiffView and keeps long lines uncrowded.
			diffStyle: "unified" as const,
			// Pierre reserves scrollbars even when short code fits. Show them only for actual overflow.
			unsafeCSS: "[data-code] { overflow: auto; }",
		}),
		[showLineNumbers, theme, wrapLongLines],
	);

	// key forces a full Pierre remount on theme/font-size change, so the worker can't emit stale theme tokens.
	const instanceKey = `${theme.light}:${theme.dark}:${fontSizePx}:${showLineNumbers ? 1 : 0}:${wrapLongLines ? 1 : 0}`;

	return (
		<DiffsWorkerPoolProvider>
			<div
				className="ling-diffs-file w-full overflow-x-auto bg-transparent"
				data-language={language}
				style={diffsStyle}
			>
				<DiffsFile key={instanceKey} file={file} options={options} className="w-full" style={diffsStyle} />
			</div>
		</DiffsWorkerPoolProvider>
	);
}
