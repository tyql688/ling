import { useTranslation } from "react-i18next";
import { useAtomValue, useSetAtom } from "jotai";
import { editorOutlineAtom, editorRevealAtom } from "./editor-navigation";
export function EditorOutline({ viewKey }: { viewKey: string }) {
	const outline = useAtomValue(editorOutlineAtom),
		reveal = useSetAtom(editorRevealAtom),
		{ t } = useTranslation();
	if (!outline || outline.viewKey !== viewKey) return null;
	return (
		<details open className="shrink-0 max-h-[40%] overflow-auto border-t border-border-subtle text-xs">
			<summary className="cursor-pointer px-3 py-2 font-medium text-text-muted">{t("editor.outline")}</summary>
			{outline.error ? (
				<p className="px-3 pb-2 text-danger">{outline.error}</p>
			) : outline.loading ? (
				<p className="px-3 pb-2 text-text-muted">{t("common.loading")}</p>
			) : (
				outline.items.map((item) => (
					<button
						type="button"
						key={`${item.name}:${item.range.startLineNumber}:${item.range.startColumn}`}
						className="block w-full truncate py-1 pr-2 text-left text-text-secondary hover:bg-surface-hover"
						style={{ paddingLeft: 12 + item.depth * 12 }}
						title={item.detail || item.name}
						onClick={() => reveal({ viewKey, path: outline.path, range: item.range, nonce: crypto.randomUUID() })}
					>
						{item.name}
					</button>
				))
			)}
		</details>
	);
}
