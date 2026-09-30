import * as monaco from "monaco-editor";
import { useRef, useEffect } from "react";
import { useMonacoSkinTheme } from "@renderer/lib/appearance/skins/use-monaco-skin-theme";
import { CODE_PREVIEW_DEFAULTS } from "@renderer/lib/preferences/code-preview";
import { monacoLanguage } from "./monaco-documents";
export function MonacoConflictDiff({ path, local, disk }: { path: string; local: string; disk: string }) {
	const containerRef = useRef<HTMLDivElement | null>(null);
	const monacoTheme = useMonacoSkinTheme();
	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;
		const nonce = crypto.randomUUID();
		const language = monacoLanguage(path);
		const localModel = monaco.editor.createModel(
			local,
			language,
			monaco.Uri.from({ scheme: "ling-conflict", path: `/${nonce}/local/${path}` }),
		);
		const diskModel = monaco.editor.createModel(
			disk,
			language,
			monaco.Uri.from({ scheme: "ling-conflict", path: `/${nonce}/disk/${path}` }),
		);
		const editor = monaco.editor.createDiffEditor(container, {
			automaticLayout: true,
			contextmenu: false,
			fontFamily: CODE_PREVIEW_DEFAULTS.fontFamily,
			fontSize: CODE_PREVIEW_DEFAULTS.fontSizePx,
			lineNumbers: CODE_PREVIEW_DEFAULTS.showLineNumbers ? "on" : "off",
			minimap: { enabled: false },
			originalEditable: false,
			readOnly: true,
			renderSideBySide: true,
			scrollBeyondLastLine: false,
			theme: monacoTheme,
			wordWrap: CODE_PREVIEW_DEFAULTS.wrapLongLines ? "on" : "off",
		});
		editor.setModel({ original: localModel, modified: diskModel });
		return () => {
			editor.dispose();
			diskModel.dispose();
			localModel.dispose();
		};
		// Theme swaps update Monaco globally; recreating this editor would lose its scroll position.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [disk, local, path]);
	return <div ref={containerRef} className="min-h-0 flex-1" />;
}
