import * as monaco from "monaco-editor";
import { codeLanguage } from "@renderer/lib/code-language";
import { fileDocumentKey, retainFileDocument } from "./file-document-state";
import type { LingApi } from "@ling/contracts/api/ling-api";
export interface TextDocument {
	content: string;
	revision: string;
}

export interface MonacoModelRecord {
	baseRevision: string;
	baseContent: string;
	releaseDocument: () => void;
	/** Monaco's undo-stable identity for the last saved content. Null means the user chose
	 * to retain a local conflict version that does not exist in this model's undo graph. */
	baseAlternativeVersionId: number | null;
	model: monaco.editor.ITextModel;
	viewStates: Map<string, monaco.editor.ICodeEditorViewState>;
	activeEditors: number;
	lastUsed: number;
}

export const modelRecords = new Map<string, MonacoModelRecord>();
const saveListeners = new Set<(model: monaco.editor.ITextModel, savedText: string) => void>();
export function onModelSaved(listener: (model: monaco.editor.ITextModel, savedText: string) => void) {
	saveListeners.add(listener);
	return () => {
		saveListeners.delete(listener);
	};
}
export function notifyModelSaved(record: MonacoModelRecord) {
	for (const listener of saveListeners) listener(record.model, record.baseContent);
}
/** Twelve clean inactive models preserve normal file-switch undo/scroll state while bounding
 * Monaco token/AST memory. Dirty models are never evicted, so the limit is deliberately soft. */
const MAX_INACTIVE_MODEL_RECORDS = 12;
let modelUseSequence = 0;

window.addEventListener(
	"pagehide",
	() => {
		for (const record of modelRecords.values()) {
			record.releaseDocument();
			record.model.dispose();
		}
		modelRecords.clear();
	},
	{ once: true },
);

export function modelUri(cwd: string, path: string): monaco.Uri {
	const normalizedCwd = cwd.replaceAll("\\", "/").replace(/^\/+/, "");
	return monaco.Uri.from({ scheme: "ling-project", authority: "workspace", path: `/${normalizedCwd}/${path}` });
}

export function monacoLanguage(path: string): string {
	const language = codeLanguage(path);
	if (language === "tsx") return "typescript";
	if (language === "jsx") return "javascript";
	if (language === "text") return "plaintext";
	if (language === "mdx") return "markdown";
	return language;
}

export function recordDirty(record: MonacoModelRecord): boolean {
	return (
		record.baseAlternativeVersionId === null ||
		record.model.getAlternativeVersionId() !== record.baseAlternativeVersionId
	);
}

export function touchRecord(record: MonacoModelRecord): void {
	modelUseSequence += 1;
	record.lastUsed = modelUseSequence;
}

export function trimModelRecords(): void {
	while (modelRecords.size > MAX_INACTIVE_MODEL_RECORDS) {
		let candidate: [string, MonacoModelRecord] | null = null;
		for (const entry of modelRecords) {
			const record = entry[1];
			if (record.activeEditors > 0 || recordDirty(record)) continue;
			if (candidate === null || record.lastUsed < candidate[1].lastUsed) candidate = entry;
		}
		if (candidate === null) return;
		modelRecords.delete(candidate[0]);
		candidate[1].releaseDocument();
		candidate[1].model.dispose();
	}
}

/** Every edit, including an unopened file in a refactoring, enters the same model and save owner. */
export function createModelRecord(
	cwd: string,
	path: string,
	document: TextDocument,
	api: LingApi["project"],
	markDirty: (input: { key: string; dirty: boolean }) => void,
): MonacoModelRecord {
	const key = fileDocumentKey(cwd, path),
		existing = modelRecords.get(key);
	if (existing) return existing;
	const model = monaco.editor.createModel(document.content, monacoLanguage(path), modelUri(cwd, path));
	const record: MonacoModelRecord = {
		model,
		baseRevision: document.revision,
		baseContent: document.content,
		baseAlternativeVersionId: model.getAlternativeVersionId(),
		releaseDocument: () => {},
		viewStates: new Map(),
		activeEditors: 0,
		lastUsed: 0,
	};
	const changed = model.onDidChangeContent(() => markDirty({ key, dirty: recordDirty(record) }));
	const release = retainFileDocument(key, {
		content: () => model.getValue(),
		async save() {
			const content = model.getValue(),
				version = model.getAlternativeVersionId();
			const result = await api.writeFile({ cwd, path, content, expectedRevision: record.baseRevision });
			record.baseRevision = result.revision;
			record.baseContent = content;
			record.baseAlternativeVersionId = version;
			notifyModelSaved(record);
			markDirty({ key, dirty: recordDirty(record) });
			return !recordDirty(record);
		},
		discard() {
			model.setValue(record.baseContent);
			record.baseAlternativeVersionId = model.getAlternativeVersionId();
			markDirty({ key, dirty: false });
		},
	});
	record.releaseDocument = () => {
		release();
		changed.dispose();
	};
	modelRecords.set(key, record);
	touchRecord(record);
	return record;
}
