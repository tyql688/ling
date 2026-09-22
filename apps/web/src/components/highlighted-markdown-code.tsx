import { DiffsWorkerPoolProvider } from "@renderer/components/diffs-worker-pool-provider";
import { File as DiffsFile, type FileContents, type FileOptions } from "@pierre/diffs/react";
import { codeHighlightLanguage } from "@renderer/lib/code-highlighting/languages";
import { CODE_PREVIEW_DEFAULTS } from "@renderer/lib/preferences/code-preview";
import { type CSSProperties, type ReactNode, useLayoutEffect, useMemo, useRef, useState } from "react";

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
	fallback,
}: {
	code: string;
	language: string;
	showLineNumbers: boolean;
	theme: { light: string; dark: string };
	wrapLongLines: boolean;
	fallback: ReactNode;
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

	// Readiness belongs to this exact code and presentation. Retired workers cannot expose
	// an empty replacement or mark a later code view ready with stale results.
	const instanceKey = `${file.cacheKey}:${showLineNumbers ? 1 : 0}:${wrapLongLines ? 1 : 0}`;

	return (
		<DiffsWorkerPoolProvider>
			<HighlightedCodeView key={instanceKey} file={file} options={options} fallback={fallback} />
		</DiffsWorkerPoolProvider>
	);
}

function HighlightedCodeView({
	file,
	options,
	fallback,
}: {
	file: FileContents;
	options: FileOptions<undefined>;
	fallback: ReactNode;
}) {
	const [ready, setReady] = useState(false);
	const highlightedRef = useRef<HTMLDivElement | null>(null);
	useLayoutEffect(() => {
		const element = highlightedRef.current;
		if (!element) return;
		// Pierre emits its mount callback before a cold worker has produced any code.
		// Keep the readable fallback until the replacement actually occupies space.
		const observer = new ResizeObserver((entries) => {
			if (!entries.some((entry) => entry.contentRect.height > 0)) return;
			setReady(true);
			observer.disconnect();
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, []);

	return (
		<div className="ling-diffs-file grid w-full overflow-x-auto bg-transparent" style={diffsStyle}>
			{/* The readable code owns the real height until Pierre has committed its DOM. */}
			{!ready && <div className="col-start-1 row-start-1 min-w-0">{fallback}</div>}
			<div
				ref={highlightedRef}
				className="col-start-1 row-start-1 min-w-0 self-start"
				// Ready code still inherits the visibility of an inactive workspace or settings page.
				style={{ visibility: ready ? undefined : "hidden" }}
				inert={!ready}
			>
				<DiffsFile file={file} options={options} className="w-full" style={diffsStyle} />
			</div>
		</div>
	);
}
