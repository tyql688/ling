import { activeSkinAppearanceAtom } from "@renderer/lib/appearance/skin-state";
import { useAtomValue } from "jotai";
import { MermaidBlockNode } from "markstream-react";

/** Bound large diagrams to a 320px preview while retaining zoom and fullscreen. */
const MAX_PREVIEW_HEIGHT = "320px";

export function MarkdownMermaidBlock({ code }: { code: string }) {
	const { appearance } = useAtomValue(activeSkinAppearanceAtom);
	return (
		<MermaidBlockNode
			node={{ type: "code_block", language: "mermaid", code, raw: code }}
			isDark={appearance === "dark"}
			loading={false}
			maxHeight={MAX_PREVIEW_HEIGHT}
			isStrict
			enableMermaidInteractions={false}
			showExportButton
			showCopyButton
			showFullscreenButton
			showZoomControls
		/>
	);
}
