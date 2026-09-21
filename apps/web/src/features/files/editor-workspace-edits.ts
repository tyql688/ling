import type { LingApi } from "@ling/contracts/api/ling-api";
import { languageLimits, type EditorWorkspaceChange } from "@ling/contracts/editor-language";
import {
	createModelRecord,
	modelRecords,
	recordDirty,
	type MonacoModelRecord,
	trimModelRecords,
} from "./monaco-documents";
import { fileDocumentKey } from "./file-document-state";
import { editorRange } from "./editor-coordinates";

interface PreparedEditorFile {
	path: string;
	before: string;
	after: string;
	version: number;
	record: MonacoModelRecord;
	edits: Array<{ range: ReturnType<typeof editorRange>; text: string }>;
}
export interface PreparedEditorChange {
	label: string;
	files: PreparedEditorFile[];
	apply(): void;
	release(): void;
}

export async function prepareEditorChange(
	cwd: string,
	change: EditorWorkspaceChange,
	api: LingApi["project"],
	markDirty: (input: { key: string; dirty: boolean }) => void,
): Promise<PreparedEditorChange> {
	// A review is interactive; refuse oversized proposals instead of retaining an entire generated project.
	if (change.files.length > languageLimits.editFiles)
		throw new Error("Review at most 50 files in one editor operation");
	const files: PreparedEditorFile[] = [];
	let bytes = 0,
		released = false;
	const release = () => {
		if (released) return;
		released = true;
		for (const file of files) file.record.activeEditors--;
		trimModelRecords();
	};
	try {
		if (new Set(change.files.map((file) => file.path)).size !== change.files.length)
			throw new Error("An edit proposal repeats a file");
		for (const file of change.files) {
			let record = modelRecords.get(fileDocumentKey(cwd, file.path));
			if (file.version === null && record && recordDirty(record))
				throw new Error(`Save the unsynchronized buffer before applying this disk-based edit: ${file.path}`);
			if (!record || file.version === null) {
				const preview = await api.readFilePreview({ cwd, path: file.path });
				if (preview.kind !== "text") throw new Error(`Cannot edit this file: ${file.path}`);
				if (file.version === null && preview.revision !== file.baseRevision)
					throw new Error(`The file changed after the language edit was proposed: ${file.path}`);
				if (!record) record = createModelRecord(cwd, file.path, preview, api, markDirty);
				else if (record.baseRevision !== preview.revision) {
					if (recordDirty(record)) throw new Error(`The buffer changed while preparing edits: ${file.path}`);
					record.baseRevision = preview.revision;
					record.baseContent = preview.content;
					record.model.setValue(preview.content);
					record.baseAlternativeVersionId = record.model.getAlternativeVersionId();
					markDirty({ key: fileDocumentKey(cwd, file.path), dirty: false });
				}
			}
			const model = record.model,
				before = model.getValue(),
				version = model.getVersionId();
			if (file.version !== null && file.version !== version) throw new Error(`The file changed: ${file.path}`);
			const edits = file.edits.map((edit) => ({ range: editorRange(edit.range), text: edit.newText }));
			const offsets = edits
				.map((edit) => {
					if (!model.validateRange(edit.range).equalsRange(edit.range))
						throw new Error(`Invalid edit range: ${file.path}`);
					return {
						start: model.getOffsetAt(edit.range.getStartPosition()),
						end: model.getOffsetAt(edit.range.getEndPosition()),
						text: edit.text,
					};
				})
				.sort((a, b) => a.start - b.start || a.end - b.end);
			let end = -1;
			for (const edit of offsets) {
				if (edit.start < end) throw new Error(`Overlapping edits: ${file.path}`);
				end = edit.end;
			}
			let after = before;
			for (const edit of offsets.toReversed()) after = after.slice(0, edit.start) + edit.text + after.slice(edit.end);
			bytes += (before.length + after.length) * 2;
			if (bytes > 8 * 1_048_576) throw new Error("The edit preview exceeds the 8 MiB review budget");
			record.activeEditors++;
			files.push({ path: file.path, before, after, version, record, edits });
		}
		return {
			label: change.label,
			files,
			release,
			apply() {
				if (released) throw new Error("This edit preview has expired");
				// Validate every buffer before the first mutation; applying is synchronous and uses Monaco's undo stack.
				for (const file of files)
					if (file.record.model.isDisposed() || file.record.model.getVersionId() !== file.version)
						throw new Error(`The file changed while reviewing: ${file.path}`);
				for (const file of files) {
					const model = file.record.model;
					model.pushStackElement();
					model.pushEditOperations(null, file.edits, () => null);
					model.pushStackElement();
				}
			},
		};
	} catch (error) {
		release();
		throw error;
	}
}
