import { useAtomValue, useSetAtom } from "jotai";
import { useDomainApi } from "@renderer/lib/host-api-context";
import { dirtyFileDocumentsAtom, fileDocumentKey, markFileDocumentDirtyAtom } from "./file-document-state";
import type { ProjectWriteFileResult } from "@ling/contracts/project";
import type { LingErrorDto } from "@ling/contracts/ling-error";
import { Button } from "@renderer/components/ui/button";
import { useMonacoSkinTheme } from "@renderer/lib/appearance/skins/use-monaco-skin-theme";
import { formatRequestError } from "@renderer/lib/errors";
import { CODE_PREVIEW_DEFAULTS } from "@renderer/lib/preferences/code-preview";
import { cn } from "@renderer/lib/utils";
import "@renderer/features/files/monaco-environment";
import { AlertTriangle, Check, Save } from "lucide-react";
import * as monaco from "monaco-editor";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { WORKSPACE_SUBHEADER_CLASS } from "../../components/shell-chrome";

import {
	monacoLanguage,
	recordDirty,
	touchRecord,
	trimModelRecords,
	createModelRecord,
	notifyModelSaved,
	type TextDocument,
	type MonacoModelRecord,
} from "./monaco-documents";
/** Saved confirmation remains visible long enough to register without becoming persistent status. */
const SAVED_FLASH_DURATION_MS = 1_200;

import { MonacoConflictDiff } from "./monaco-conflict-diff";
import { useEditorFeatures } from "./use-editor-features";
import { EditorContextMenu, EditorDialogs } from "./editor-tools";
import type { WorkspaceFilePreviewProps } from "./use-file-preview-pane";

export function MonacoFileEditor({
	viewKey,
	cwd,
	path,
	document,
	saving,
	saveError,
	onSave,
	onSelectionLineRangeChange,
	toolbarActions,
	onOpenFile,
	onInsertReference,
}: {
	viewKey: string;
	cwd: string;
	path: string;
	document: TextDocument;
	saving: boolean;
	saveError: LingErrorDto | null;
	onSave(content: string, expectedRevision: string): Promise<ProjectWriteFileResult>;
	onSelectionLineRangeChange(range: { start: number; end: number } | null): void;
	/** File actions merged into the editor toolbar when a working-set tab already owns the title. */
	toolbarActions?: ReactNode;
	onOpenFile: WorkspaceFilePreviewProps["onOpenFile"];
	onInsertReference: WorkspaceFilePreviewProps["onInsertReference"];
}) {
	const { t } = useTranslation();
	const projectApi = useDomainApi("project");
	const containerRef = useRef<HTMLDivElement>(null);
	const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
	const [activeEditor, setActiveEditor] = useState<monaco.editor.IStandaloneCodeEditor | null>(null);
	const features = useEditorFeatures(activeEditor, { cwd, path, viewKey, onOpenFile, onInsertReference });
	const recordRef = useRef<MonacoModelRecord | null>(null);
	const saveRef = useRef<() => Promise<void>>(() => Promise.resolve());
	const savedFlashTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
	const dirtyDocuments = useAtomValue(dirtyFileDocumentsAtom);
	const markDirty = useSetAtom(markFileDocumentDirtyAtom);
	const [conflict, setConflict] = useState<TextDocument | null>(null);
	const [savedFlashKey, setSavedFlashKey] = useState<string | null>(null);
	const monacoTheme = useMonacoSkinTheme();
	const currentModelKey = fileDocumentKey(cwd, path);
	const dirty = dirtyDocuments.has(currentModelKey);
	const setDirty = useCallback(
		(dirty: boolean) => markDirty({ key: currentModelKey, dirty }),
		[currentModelKey, markDirty],
	);
	const currentModelKeyRef = useRef(currentModelKey);
	currentModelKeyRef.current = currentModelKey;
	const savedFlash = savedFlashKey === currentModelKey;
	const saveErrorMessage =
		saveError === null
			? null
			: saveError.code === "PROJECT_FILE_WRITE_BLOCKED"
				? t("explorer.projectFileWriteBlocked")
				: formatRequestError(saveError);

	useEffect(() => {
		if (savedFlashTimerRef.current !== null) window.clearTimeout(savedFlashTimerRef.current);
		savedFlashTimerRef.current = null;
		setSavedFlashKey(null);
		return () => {
			if (savedFlashTimerRef.current !== null) window.clearTimeout(savedFlashTimerRef.current);
			savedFlashTimerRef.current = null;
		};
	}, [currentModelKey]);

	const save = useCallback(async (): Promise<void> => {
		const record = recordRef.current;
		if (!record || conflict !== null || saving) return;
		const content = record.model.getValue();
		const savedAlternativeVersionId = record.model.getAlternativeVersionId();
		let result: ProjectWriteFileResult;
		try {
			result = await onSave(content, record.baseRevision);
		} catch {
			return;
		}
		record.baseRevision = result.revision;
		record.baseContent = content;
		record.baseAlternativeVersionId = savedAlternativeVersionId;
		notifyModelSaved(record);
		markDirty({ key: currentModelKey, dirty: recordDirty(record) });
		if (recordRef.current !== record || currentModelKeyRef.current !== currentModelKey) return;
		setDirty(recordDirty(record));
		setConflict((current) => (current?.revision === result.revision && current.content === content ? null : current));
		if (savedFlashTimerRef.current !== null) window.clearTimeout(savedFlashTimerRef.current);
		setSavedFlashKey(currentModelKey);
		savedFlashTimerRef.current = window.setTimeout(() => {
			savedFlashTimerRef.current = null;
			setSavedFlashKey((current) => (current === currentModelKey ? null : current));
		}, SAVED_FLASH_DURATION_MS);
	}, [conflict, currentModelKey, onSave, saving, markDirty, setDirty]);

	saveRef.current = save;

	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;
		const record = createModelRecord(cwd, path, document, projectApi, markDirty);
		record.activeEditors += 1;
		touchRecord(record);
		recordRef.current = record;
		setConflict(null);
		if (record.baseRevision !== document.revision) {
			if (!recordDirty(record)) {
				record.baseRevision = document.revision;
				record.baseContent = document.content;
				record.model.setValue(document.content);
				record.baseAlternativeVersionId = record.model.getAlternativeVersionId();
			} else {
				setConflict(document);
			}
		}
		setDirty(recordDirty(record));
		const editor = monaco.editor.create(container, {
			model: record.model,
			automaticLayout: true,
			contextmenu: false,
			fontFamily: CODE_PREVIEW_DEFAULTS.fontFamily,
			fontSize: CODE_PREVIEW_DEFAULTS.fontSizePx,
			lineNumbers: CODE_PREVIEW_DEFAULTS.showLineNumbers ? "on" : "off",
			minimap: { enabled: false },
			padding: { top: 8, bottom: 8 },
			renderWhitespace: "selection",
			scrollBeyondLastLine: false,
			smoothScrolling: false,
			theme: monacoTheme,
			wordWrap: CODE_PREVIEW_DEFAULTS.wrapLongLines ? "on" : "off",
		});
		editorRef.current = editor;
		setActiveEditor(editor);
		const viewState = record.viewStates.get(viewKey);
		if (viewState) editor.restoreViewState(viewState);
		const contentListener = record.model.onDidChangeContent(() => {
			setDirty(recordDirty(record));
		});
		const selectionListener = editor.onDidChangeCursorSelection(({ selection }) => {
			onSelectionLineRangeChange({
				start: Math.min(selection.startLineNumber, selection.endLineNumber),
				end: Math.max(selection.startLineNumber, selection.endLineNumber),
			});
		});
		const saveAction = editor.addAction({
			id: "ling.workspace.save",
			label: t("explorer.saveFile"),
			keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
			run: () => saveRef.current(),
		});
		return () => {
			const viewState = editor.saveViewState();
			if (viewState) {
				record.viewStates.delete(viewKey);
				record.viewStates.set(viewKey, viewState);
				// Reading positions are lightweight, but a shared file must not retain every past session.
				while (record.viewStates.size > 40) record.viewStates.delete(record.viewStates.keys().next().value!);
			}
			record.activeEditors -= 1;
			touchRecord(record);
			saveAction.dispose();
			selectionListener.dispose();
			contentListener.dispose();
			editor.dispose();
			editorRef.current = null;
			setActiveEditor(null);
			recordRef.current = null;
			onSelectionLineRangeChange(null);
			trimModelRecords();
		};
		// Document revisions are reconciled by the effect below and theme changes update Monaco globally;
		// recreating the editor for either would discard selection, scroll, and undo state.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [cwd, path, viewKey, t, onSelectionLineRangeChange]);

	useEffect(() => {
		const record = recordRef.current;
		if (!record || record.baseRevision === document.revision) return;
		if (!recordDirty(record)) {
			record.baseRevision = document.revision;
			record.baseContent = document.content;
			record.model.setValue(document.content);
			record.baseAlternativeVersionId = record.model.getAlternativeVersionId();
			setDirty(false);
			setConflict(null);
		} else setConflict(document);
	}, [document, setDirty]);

	const useDiskVersion = () => {
		const record = recordRef.current;
		if (!record || !conflict) return;
		record.baseRevision = conflict.revision;
		record.baseContent = conflict.content;
		record.model.setValue(conflict.content);
		record.baseAlternativeVersionId = record.model.getAlternativeVersionId();
		setConflict(null);
		setDirty(false);
	};
	const keepLocalVersion = () => {
		const record = recordRef.current;
		if (!record || !conflict) return;
		record.baseRevision = conflict.revision;
		record.baseContent = conflict.content;
		record.baseAlternativeVersionId = null;
		setConflict(null);
		setDirty(true);
	};

	return (
		<div className="relative flex h-full min-h-0 flex-col bg-transparent">
			<div className={cn(WORKSPACE_SUBHEADER_CLASS, "gap-2 text-xs text-text-muted")}>
				<span className="uppercase tracking-wide">{monacoLanguage(path)}</span>
				{features.error && (
					<button
						type="button"
						className="max-w-64 truncate text-danger"
						title={features.error}
						onClick={features.retry}
					>
						{t("editor.retryLanguage")}
					</button>
				)}
				<span className="min-w-0 flex-1 truncate">
					{saveErrorMessage
						? t("explorer.saveFailed", { message: saveErrorMessage })
						: dirty
							? t("explorer.unsavedFile")
							: savedFlash
								? t("explorer.savedFile")
								: ""}
				</span>
				{toolbarActions}
				<Button
					type="button"
					variant="ghost"
					size="sm"
					disabled={!dirty || saving || conflict !== null}
					onClick={() => void save()}
					className="h-6 gap-1 px-2 text-xs"
				>
					{savedFlash && !dirty ? (
						<Check className="size-3" aria-hidden="true" />
					) : (
						<Save className="size-3" aria-hidden="true" />
					)}
					{saving ? t("explorer.savingFile") : t("explorer.saveFile")}
				</Button>
			</div>
			{conflict && (
				<div className="flex shrink-0 items-center gap-2 border-warning/30 border-b bg-warning/8 px-3 py-2 text-xs">
					<AlertTriangle className="size-4 shrink-0 text-warning" aria-hidden="true" />
					<div className="min-w-0 flex-1">
						<div className="font-medium text-text-primary">{t("explorer.externalChangeTitle")}</div>
						<div className="text-text-muted">{t("explorer.externalChangeDescription")}</div>
					</div>
					<Button type="button" variant="outline" size="sm" onClick={keepLocalVersion} className="h-7">
						{t("explorer.keepLocalVersion")}
					</Button>
					<Button type="button" variant="outline" size="sm" onClick={useDiskVersion} className="h-7">
						{t("explorer.useDiskVersion")}
					</Button>
				</div>
			)}
			<EditorContextMenu features={features} hidden={conflict !== null}>
				<div
					ref={containerRef}
					className={cn("min-h-0 flex-1", conflict && "hidden", saveError && "ring-1 ring-inset ring-danger/30")}
				/>
			</EditorContextMenu>
			<EditorDialogs features={features} />
			{conflict && (
				<MonacoConflictDiff path={path} local={recordRef.current?.model.getValue() ?? ""} disk={conflict.content} />
			)}
		</div>
	);
}
