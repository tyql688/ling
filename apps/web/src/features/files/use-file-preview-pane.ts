import type { WorkspaceFilePreviewProps } from "./file-reading";
import type { ProjectFilePreview } from "@ling/contracts/project";
import { lazy, useEffect, useLayoutEffect, useState } from "react";

import { useTranslation } from "react-i18next";

import { useWorkspaceFilePreview } from "./use-workspace-file-preview";

import { countTextLines } from "./workspace-explorer-format";

const MonacoFileEditor = lazy(() =>
	import("./editor/monaco-file-editor").then(({ MonacoFileEditor }) => ({ default: MonacoFileEditor })),
);

function useWorkspaceImageUrl(preview: ProjectFilePreview | null): string | null {
	const image = preview?.kind === "image" ? preview : null;
	const [url, setUrl] = useState<string | null>(null);
	// A blob URL pins its decoded bytes for the document's lifetime, so it must be created and
	// revoked by the same effect run. Creating it in a useMemo factory leaks the copy React
	// discards whenever it invokes the factory twice (StrictMode, interrupted renders).
	useEffect(() => {
		if (image === null) {
			setUrl(null);
			return;
		}
		const created = URL.createObjectURL(new Blob([Uint8Array.from(image.data).buffer], { type: image.mime }));
		setUrl(created);
		return () => {
			setUrl(null);
			URL.revokeObjectURL(created);
		};
	}, [image]);
	return url;
}

/** Owns preview loading, selection references and authenticated image URLs. */
export function useFilePreviewPane({
	cwd,
	path,
	refreshRevision,
	onCopyPath,
	onInsertReference,
	onRevealEntry,
}: WorkspaceFilePreviewProps) {
	const { t, i18n } = useTranslation();
	const [selectionLineRange, setSelectionLineRange] = useState<{ start: number; end: number } | null>(null);
	const { preview, error, loading, reload, save, saving, saveError } = useWorkspaceFilePreview({
		cwd,
		path,
		open: true,
		refreshRevision,
	});
	useLayoutEffect(() => setSelectionLineRange(null), [cwd, path]);
	const locale = i18n.resolvedLanguage === undefined ? i18n.language : i18n.resolvedLanguage;
	const imageUrl = useWorkspaceImageUrl(preview);

	const insertSelectionReference = () => {
		if (path === null || selectionLineRange === null) return;
		// A whole-file selection equals a bare reference — no line numbers.
		const totalLines = preview?.kind === "text" ? countTextLines(preview.content) : 0;
		if (totalLines > 0 && selectionLineRange.start === 1 && selectionLineRange.end >= totalLines) {
			onInsertReference(path);
		} else {
			onInsertReference(path, { lineRange: selectionLineRange });
		}
		// The selection was consumed by the reference: clear the highlight so a later bare right-click doesn't carry stale line numbers.
		setSelectionLineRange(null);
	};

	const editorOwnsToolbar = preview?.kind === "text";
	return {
		path,
		t,
		onInsertReference,
		onCopyPath,
		onRevealEntry,
		reload,
		loading,
		editorOwnsToolbar,
		setSelectionLineRange,
		error,
		preview,
		MonacoFileEditor,
		cwd,
		saving,
		saveError,
		save,
		imageUrl,
		locale,
		selectionLineRange,
		insertSelectionReference,
	};
}
