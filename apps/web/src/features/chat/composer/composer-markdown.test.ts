import { describe, expect, it } from "vitest";
import { Transform } from "@tiptap/pm/transform";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { history, undo, redo } from "@tiptap/pm/history";
import { getSchema } from "@tiptap/core";
import type { SessionDraft } from "@renderer/features/sessions/state/drafts";
import { normalizeContextPositions, rebaseContextPositions } from "@renderer/features/sessions/state/draft-context";
import {
	composerDocumentFromDraft,
	composerExtensions,
	composerSchema,
	createMarkdownPositionMapper,
	draftFromComposerProjection,
	parseComposerMarkdown,
	projectComposerDocument,
	projectPlainComposerDocument,
	createPlainPositionMapper,
	parsePlainComposerText,
} from "./composer-markdown";

describe("composer Markdown and context projection", () => {
	it("preserves Markdown source, whitespace, UTF-16 positions and contexts in plain editing", () => {
		const draft: SessionDraft = {
			text: "# 中文 😀\n\n**bold**  and <tag>\n  code\n",
			attachments: [],
			reviewComments: [],
			pastedBlocks: [],
			fileReferences: [{ id: "f", scope: "project", path: "file.ts" }],
			contextPositions: [{ kind: "file", id: "f", offset: 18 }],
		};
		const plain = composerDocumentFromDraft(draft, () => "@file.ts", false);
		const projected = projectPlainComposerDocument(plain);
		expect(projected.text).toBe(draft.text);
		expect(projected.contextPositions).toEqual([]);
		const positionAt = createPlainPositionMapper(plain);
		for (let offset = 0; offset <= draft.text.length; offset += 1)
			expect(projectPlainComposerDocument(plain, positionAt(offset)).cursorOffset).toBe(offset);
		const rich = composerDocumentFromDraft(draftFromComposerProjection(projected, draft), () => "@file.ts");
		const roundTrip = draftFromComposerProjection(projectComposerDocument(rich), draft);
		expect(projectPlainComposerDocument(composerDocumentFromDraft(roundTrip, () => "@file.ts", false)).text).toBe(
			roundTrip.text,
		);
		expect(roundTrip.fileReferences).toEqual(draft.fileReferences);
		expect(projectPlainComposerDocument(parsePlainComposerText("")).text).toBe("");
	});

	it("pastes Markdown using the mounted editor's schema instead of dropping foreign nodes", () => {
		const schema = getSchema(composerExtensions);
		const doc = schema.topNodeType.createAndFill()!;
		const state = EditorState.create({ doc });
		const pasted = parseComposerMarkdown("# Heading\n\n**body**", schema);
		const next = state.apply(state.tr.replaceSelection(pasted.slice(0, pasted.content.size)));
		expect(next.doc.textContent).toContain("Heading");
		expect(next.doc.textContent).toContain("body");
		expect(() => next.doc.check()).not.toThrow();
	});

	it("maps text cursors through entities, formatting and nested Markdown containers", () => {
		for (const source of [
			"中文 😀 **bold** <env> and `code`",
			"> quote **bold**\n> next",
			"- one\n- two",
			"| A | B |\n| --- | --- |\n| x | y |",
			"```ts\n  a < b;\n  x();\n```",
			"> ```ts\n>  a\n>  b\n> ```",
		]) {
			const doc = parseComposerMarkdown(source);
			const map = createMarkdownPositionMapper(doc);
			doc.descendants((node, position) => {
				if (!node.isText) return;
				for (let index = 0; index <= node.nodeSize; index += 1) {
					const offset = projectComposerDocument(doc, position + index).cursorOffset;
					expect(projectComposerDocument(doc, map(offset)).cursorOffset, `${source} at ${index}`).toBe(offset);
				}
			});
		}
	});
	it("round-trips Markdown structure, code indentation, tables and task state", () => {
		const source =
			'# Task\n\n**bold** and *italic*, ~~removed~~ and [link](https://example.com).\n\n- [x] done\n- [ ] pending\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n```ts\n  const text = "<tag>😀";\n\n  run(text);\n```';
		const document = parseComposerMarkdown(source);
		const projected = projectComposerDocument(document);
		expect(projected.text).toContain('  const text = "<tag>😀";\n\n  run(text);');
		expect(projected.text).toContain("- [x] done");
		expect(parseComposerMarkdown(projected.text).toJSON()).toEqual(document.toJSON());
	});
	it("keeps empty input and literal angle-bracket text editable", () => {
		expect(projectComposerDocument(parseComposerMarkdown(""), 1).text).toBe("");
		for (const source of ["Use <env> here", "<environment>\nkeep this\n</environment>"]) {
			expect(parseComposerMarkdown(projectComposerDocument(parseComposerMarkdown(source)).text).textContent).toContain(
				source.includes("keep this") ? "keep this" : "<env>",
			);
		}
	});
	it("maps UTF-16 cursors through formatting and preserves inline context order on restoration", () => {
		const source = "中文 😀 **bold** and @src";
		const document = parseComposerMarkdown(source);
		const end = TextSelection.atEnd(document).from;
		const projected = projectComposerDocument(document, end);
		expect(projected.cursorOffset).toBe(projected.text.length);
		expect(createMarkdownPositionMapper(document)(projected.cursorOffset)).toBe(end);
		const context = { kind: "file", value: { id: "ref", scope: "project", path: "src/main.ts" } } as const;
		const at = createMarkdownPositionMapper(document)(6);
		const withContext = new Transform(document).insert(
			at,
			composerSchema.nodes.composerContext!.create({ context, label: "@src/main.ts" }),
		).doc;
		const snapshot = projectComposerDocument(withContext, TextSelection.atEnd(withContext).from);
		const draft = draftFromComposerProjection(snapshot);
		expect(draft.fileReferences).toEqual([context.value]);
		expect(snapshot.text).not.toContain("ref");
		const restored = composerDocumentFromDraft(draft, () => "@src/main.ts");
		expect(projectComposerDocument(restored)).toMatchObject({
			text: snapshot.text,
			contextPositions: [],
		});
	});
	it("migrates legacy context and rebases external edits without retaining deleted items", () => {
		const draft: SessionDraft = {
			text: "hello",
			attachments: [],
			reviewComments: [],
			pastedBlocks: [{ id: "p", text: "body" }],
			fileReferences: [{ id: "f", scope: "project", path: "file.ts" }],
		};
		const migrated = projectComposerDocument(composerDocumentFromDraft(draft, (context) => context.value.id));
		expect(migrated.contextPositions.map(({ kind }) => kind)).toEqual(["paste"]);
		expect(migrated.contextPositions.map(({ offset }) => offset)).toEqual([5]);
		const positions = [{ kind: "file", id: "f", offset: 5 }] as const;
		expect(rebaseContextPositions("hello", "hello world", positions)).toEqual(positions);
		expect(rebaseContextPositions("hello", "hi hello", positions)[0]?.offset).toBe(8);
		expect(normalizeContextPositions([...positions, { kind: "file", id: "missing", offset: 0 }], draft)).toEqual(
			positions,
		);
	});

	it("restores adjacent context in visual order even when their kinds differ", () => {
		const draft: SessionDraft = {
			text: "before after",
			attachments: [],
			reviewComments: [{ id: "f", filePath: "file.ts", rangeLabel: "L1", text: "fix", excerpt: "line" }],
			fileReferences: [],
			pastedBlocks: [{ id: "p", text: "body" }],
			contextPositions: [
				{ kind: "review", id: "f", offset: 7 },
				{ kind: "paste", id: "p", offset: 7 },
			],
		};
		const restored = projectComposerDocument(composerDocumentFromDraft(draft, (context) => context.value.id));
		expect(restored.text).toBe(draft.text);
		expect(restored.contextPositions).toEqual(draft.contextPositions);
	});

	it("undoes a completion as one edit and keeps context deletion and redo in sync", () => {
		const doc = parseComposerMarkdown("before @file after");
		let state = EditorState.create({ doc, plugins: [history()] });
		const context = { kind: "file", value: { id: "f", scope: "project", path: "file.ts" } } as const;
		const from = createMarkdownPositionMapper(doc)(7);
		const to = createMarkdownPositionMapper(doc)(12);
		state = state.apply(
			state.tr
				.setSelection(TextSelection.create(doc, from, to))
				.replaceSelectionWith(composerSchema.nodes.composerContext!.create({ context, label: "@file.ts" })),
		);
		expect(draftFromComposerProjection(projectComposerDocument(state.doc)).fileReferences).toEqual([context.value]);
		undo(state, (transaction) => {
			state = state.apply(transaction);
		});
		expect(projectComposerDocument(state.doc).text).toBe("before @file after");
		expect(projectComposerDocument(state.doc).contexts).toEqual([]);
		redo(state, (transaction) => {
			state = state.apply(transaction);
		});
		expect(projectComposerDocument(state.doc).contextPositions).toEqual([{ kind: "file", id: "f", offset: 7 }]);
	});

	it("keeps image Markdown and safely fits context inserted into a code block", () => {
		const image = parseComposerMarkdown('![screen](docs/screen.png "Screenshot")');
		expect(projectComposerDocument(image).text).toContain('![screen](docs/screen.png "Screenshot")');
		const doc = parseComposerMarkdown("```ts\nconst x = 1;\n```");
		const state = EditorState.create({ doc, selection: TextSelection.atEnd(doc) });
		const context = { kind: "paste", value: { id: "p", text: "body" } } as const;
		const next = state.apply(
			state.tr.replaceSelectionWith(composerSchema.nodes.composerContext!.create({ context, label: "body" })),
		);
		expect(() => next.doc.check()).not.toThrow();
		expect(projectComposerDocument(next.doc).contexts).toEqual([context]);
		expect(projectComposerDocument(next.doc).text).toContain("const x = 1;");
	});
});
