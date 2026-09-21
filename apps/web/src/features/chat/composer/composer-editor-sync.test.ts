import { describe, expect, it, vi } from "vitest";
import { getSchema } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import type { SessionDraft } from "@renderer/features/sessions/state/drafts";
import {
	composerDocumentFromDraft,
	composerExtensions,
	projectComposerDocument,
	projectPlainComposerDocument,
} from "./composer-markdown";
import { syncComposerProjection } from "./composer-editor-sync";

function draftWithText(text: string): SessionDraft {
	return { text, attachments: [], pastedBlocks: [], fileReferences: [], reviewComments: [] };
}

describe("composer editor draft synchronization", () => {
	it("publishes normalized Markdown and context positions with the cursor when switching from source mode", () => {
		const source: SessionDraft = {
			...draftWithText("# 标题\n内容"),
			fileReferences: [{ id: "file", scope: "project", path: "README.md" }],
		};
		const accepted = { current: source };
		const schema = getSchema(composerExtensions);
		const document = composerDocumentFromDraft(source, () => "@README.md", true, schema);
		expect(schema.nodeFromJSON(document.toJSON()).eq(document)).toBe(true);
		const projection = projectComposerDocument(document, TextSelection.atEnd(document).head);
		expect(projection.cursorOffset).toBeGreaterThan(source.text.length);
		const onChange = vi.fn((draft: SessionDraft, cursorOffset: number) => {
			expect(accepted.current).toBe(draft);
			expect(draft.text).toBe("# 标题\n\n内容");
			expect(cursorOffset).toBe(draft.text.length);
			expect(draft.fileReferences).toEqual(source.fileReferences);
			expect(draft.contextPositions).toEqual([{ kind: "file", id: "file", offset: 8 }]);
		});
		const onSelectionChange = vi.fn();
		syncComposerProjection(projection, accepted, onChange, onSelectionChange);
		expect(onChange).toHaveBeenCalledOnce();
		expect(onSelectionChange).not.toHaveBeenCalled();

		// Subsequent projection and caret updates must not rewrite the normalized draft.
		syncComposerProjection(projection, accepted, onChange, onSelectionChange);
		syncComposerProjection(
			projectComposerDocument(document, TextSelection.atStart(document).head),
			accepted,
			onChange,
			onSelectionChange,
		);
		expect(onChange).toHaveBeenCalledOnce();
		expect(onSelectionChange).toHaveBeenCalledTimes(2);
	});

	it("synchronizes restored source even when parsing leaves the document and selection unchanged", () => {
		const accepted = { current: draftWithText("# Title") };
		const document = composerDocumentFromDraft(accepted.current, () => "");
		const projection = projectComposerDocument(document, TextSelection.atEnd(document).head);
		accepted.current = draftWithText("Title\n=====");
		expect(composerDocumentFromDraft(accepted.current, () => "").eq(document)).toBe(true);
		const onChange = vi.fn();
		const onSelectionChange = vi.fn();
		syncComposerProjection(projection, accepted, onChange, onSelectionChange);
		expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ text: "# Title" }), 7);
		expect(onSelectionChange).not.toHaveBeenCalled();
	});

	it("keeps source whitespace and avoids draft writes when only the caret moves", () => {
		const source = draftWithText("# 标题\n\n  **body**  \n");
		const accepted = { current: source };
		const document = composerDocumentFromDraft(source, () => "", false);
		const onChange = vi.fn();
		const onSelectionChange = vi.fn();
		for (const selection of [TextSelection.atStart(document), TextSelection.atEnd(document)]) {
			syncComposerProjection(
				projectPlainComposerDocument(document, selection.head),
				accepted,
				onChange,
				onSelectionChange,
			);
		}
		expect(accepted.current).toBe(source);
		expect(onChange).not.toHaveBeenCalled();
		expect(onSelectionChange.mock.calls).toEqual([[0], [source.text.length]]);
	});
});
