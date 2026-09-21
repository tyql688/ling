import type { DraftContextPosition } from "@ling/contracts/draft";
import { contextKey, draftContexts, type DraftContext } from "@renderer/features/sessions/state/draft-context";
import type { SessionDraft } from "@renderer/features/sessions/state/drafts";
import { getSchema, Node, type JSONContent } from "@tiptap/core";
import Image from "@tiptap/extension-image";
import { renderTableToMarkdown, Table, TableKit } from "@tiptap/extension-table";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { MarkdownManager } from "@tiptap/markdown";
import type { Node as ProseMirrorNode, Schema } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import { Transform } from "@tiptap/pm/transform";
import StarterKit from "@tiptap/starter-kit";

const ComposerContextNode = Node.create({
	name: "composerContext",
	group: "inline",
	inline: true,
	atom: true,
	selectable: true,
	draggable: true,
	addOptions() {
		// Headless Markdown conversion has no clipboard boundary; the mounted editor supplies its parser.
		return {
			parseContext: (_raw: string, _cwd: string | null): DraftContext | null => null,
			projectCwd: () => null as string | null,
		};
	},
	addAttributes() {
		return {
			context: { default: null, rendered: false },
			label: { default: "", rendered: false },
			marker: { default: "", rendered: false },
		};
	},
	parseHTML() {
		return [
			{
				tag: "span[data-ling-context]",
				getAttrs: (element) => {
					const raw = element.getAttribute("data-ling-context");
					const context = raw === null ? null : this.options.parseContext(raw, element.getAttribute("data-ling-cwd"));
					return context ? { context, label: element.textContent } : false;
				},
			},
		];
	},
	renderHTML({ node }) {
		const context = node.attrs.context as DraftContext;
		return [
			"span",
			{
				"data-ling-context": JSON.stringify(context),
				"data-ling-cwd": this.options.projectCwd(),
				class: "composer-context",
				contenteditable: "false",
			},
			String(node.attrs.label),
		];
	},
	renderText({ node }) {
		return String(node.attrs.label);
	},
	renderMarkdown(node) {
		return String(node.attrs?.marker ?? "");
	},
});

/** Editor history is per mounted composer and bounded independently of persisted drafts. */
export const composerExtensions = [
	StarterKit.configure({
		undoRedo: { depth: 50 },
		underline: false,
		link: { openOnClick: false },
		trailingNode: false,
	}),
	TableKit.configure({ table: false }),
	Table.extend({
		// Column padding would count temporary cursor/context markers and change unrelated cells.
		renderMarkdown(node, helpers) {
			return renderTableToMarkdown(node, helpers)
				.replace(/[ \t]+\|/g, " |")
				.replace(/(\|[ \t]*:?)---+(:?[ \t]*)(?=\|)/g, "$1---$2");
		},
	}).configure({ resizable: false }),
	TaskList,
	TaskItem.configure({ nested: true }),
	Image.configure({ inline: true, allowBase64: true }),
	ComposerContextNode,
];

/** Source editing shares context and history, without marks, formatting commands or input rules. */
export const plainComposerExtensions = [
	StarterKit.configure({
		undoRedo: { depth: 50 },
		bold: false,
		blockquote: false,
		bulletList: false,
		code: false,
		codeBlock: false,
		heading: false,
		horizontalRule: false,
		italic: false,
		link: false,
		listItem: false,
		listKeymap: false,
		orderedList: false,
		paragraph: false,
		strike: false,
		underline: false,
		trailingNode: false,
	}),
	Node.create({
		name: "paragraph",
		group: "block",
		content: "inline*",
		marks: "",
		whitespace: "pre",
		parseHTML: () => [{ tag: "p", preserveWhitespace: "full" }],
		renderHTML: () => ["p", 0],
	}),
	ComposerContextNode,
];

const markdown = new MarkdownManager({ extensions: composerExtensions, markedOptions: { gfm: true, breaks: true } });
export const composerSchema = getSchema(composerExtensions);
const plainComposerSchema = getSchema(plainComposerExtensions);

export interface ComposerProjection {
	text: string;
	contextPositions: DraftContextPosition[];
	contexts: DraftContext[];
	cursorOffset: number;
}

function readPlainDocument(document: ProseMirrorNode) {
	let text = "";
	let seenBlock = false;
	const ranges: { node: ProseMirrorNode; position: number; offset: number; length: number }[] = [];
	document.descendants((node, position) => {
		if (node.isTextblock) {
			if (seenBlock) text += "\n";
			seenBlock = true;
			ranges.push({ node, position: position + 1, offset: text.length, length: 0 });
		}
		if (!node.isInline) return;
		const value = node.isText ? node.text! : node.type.name === "hardBreak" ? "\n" : "";
		ranges.push({ node, position, offset: text.length, length: value.length });
		text += value;
	});
	return { text, ranges };
}

export function projectPlainComposerDocument(document: ProseMirrorNode, caret?: number): ComposerProjection {
	const { text, ranges } = readPlainDocument(document);
	const contexts: DraftContext[] = [];
	const contextPositions: DraftContextPosition[] = [];
	let cursorOffset = 0;
	for (const { node, position, offset, length } of ranges) {
		if (caret !== undefined && caret >= position) cursorOffset = offset + Math.min(length, caret - position);
		if (node.type.name !== "composerContext") continue;
		const context = node.attrs.context as DraftContext;
		contexts.push(context);
		contextPositions.push({ kind: context.kind, id: context.value.id, offset });
	}
	return { text, contexts, contextPositions, cursorOffset: caret === undefined ? text.length : cursorOffset };
}

export function createPlainPositionMapper(document: ProseMirrorNode): (offset: number) => number {
	const { ranges } = readPlainDocument(document);
	return (offset) => {
		let best = TextSelection.atStart(document).from;
		for (const range of ranges) {
			if (offset < range.offset) break;
			best = range.position;
			if (range.node.isText) best += Math.min(range.length, offset - range.offset);
			else if (range.node.isInline && offset >= range.offset + range.length) best += range.node.nodeSize;
		}
		return TextSelection.near(document.resolve(best)).from;
	};
}

export function parsePlainComposerText(text: string, schema: Schema = plainComposerSchema): ProseMirrorNode {
	return schema.topNodeType.create(
		null,
		schema.nodes.paragraph!.create(null, text.length > 0 ? schema.text(text) : null),
	);
}

/** One serialization locates context and caret without mistaking Markdown syntax for document positions. */
export function projectComposerDocument(document: ProseMirrorNode, caret?: number): ComposerProjection {
	const prefix = `\uE000${crypto.randomUUID()}:`;
	const caretMarker = `${prefix}caret\uE001`;
	let input = document;
	if (caret !== undefined) {
		const position = TextSelection.near(document.resolve(Math.max(0, Math.min(caret, document.content.size)))).from;
		const resolved = document.resolve(position);
		input = new Transform(document).insert(position, document.type.schema.text(caretMarker, resolved.marks())).doc;
	}
	const contexts: DraftContext[] = [];
	const map = (node: JSONContent): JSONContent => {
		if (node.type === "composerContext") {
			const index = contexts.push(node.attrs?.context as DraftContext) - 1;
			return { ...node, attrs: { ...node.attrs, marker: `${prefix}${index}\uE001` } };
		}
		return node.content ? { ...node, content: node.content.map(map) } : node;
	};
	const serialized = markdown.serialize(map(input.toJSON() as JSONContent));
	const contextPositions: DraftContextPosition[] = [];
	let text = "";
	let cursorOffset = 0;
	let from = 0;
	for (;;) {
		const start = serialized.indexOf(prefix, from);
		if (start < 0) {
			text += serialized.slice(from);
			break;
		}
		text += serialized.slice(from, start);
		const end = serialized.indexOf("\uE001", start);
		if (end < 0) throw new Error("Incomplete composer projection marker");
		const label = serialized.slice(start + prefix.length, end);
		if (label === "caret") cursorOffset = text.length;
		else {
			const context = contexts[Number(label)];
			if (!context) throw new Error("Unknown composer projection marker");
			contextPositions.push({ kind: context.kind, id: context.value.id, offset: text.length });
		}
		from = end + 1;
	}
	return { text, contextPositions, contexts, cursorOffset: caret === undefined ? text.length : cursorOffset };
}

interface MarkdownTextRange {
	from: number;
	to: number;
	start: number;
	end: number;
	node: ProseMirrorNode;
	parent: ProseMirrorNode | null;
	encodedLength?: number;
}

/** Locate text runs in one serialization, then map within the selected run using the SDK's own escaping. */
export function createMarkdownPositionMapper(document: ProseMirrorNode): (offset: number) => number {
	const prefix = `\uE000${crypto.randomUUID()}:`;
	const ranges: MarkdownTextRange[] = [];
	const marker = (index: number, edge: string) => `${prefix}${index}:${edge}\uE001`;
	const map = (node: ProseMirrorNode, position: number, parent: ProseMirrorNode | null): JSONContent[] => {
		const json = node.toJSON() as JSONContent;
		if (node.isText || node.isInline || (node.isTextblock && node.childCount === 0)) {
			const from = node.isTextblock ? position + 1 : position;
			const index =
				ranges.push({ from, to: node.isTextblock ? from : position + node.nodeSize, start: 0, end: 0, node, parent }) -
				1;
			const start = marker(index, "s"),
				end = marker(index, "e");
			if (node.isText) return [{ ...json, text: start + node.text + end }];
			if (node.type.name === "composerContext") return [{ ...json, attrs: { ...json.attrs, marker: start + end } }];
			if (node.isTextblock) return [{ ...json, content: [{ type: "text", text: start + end }] }];
			return [{ type: "text", text: start }, json, { type: "text", text: end }];
		}
		const content: JSONContent[] = [];
		node.forEach((child, offset) => content.push(...map(child, (node === document ? 0 : position + 1) + offset, node)));
		return [{ ...json, content }];
	};
	const serialized = markdown.serialize(map(document, 0, null));
	let from = 0,
		length = 0;
	for (;;) {
		const start = serialized.indexOf(prefix, from);
		if (start < 0) break;
		length += start - from;
		const end = serialized.indexOf("\uE001", start);
		const [index, edge] = serialized.slice(start + prefix.length, end).split(":");
		const range = ranges[Number(index)];
		if (!range || end < 0) throw new Error("Invalid Markdown position marker");
		if (edge === "s") range.start = length;
		else range.end = length;
		from = end + 1;
	}
	return (offset) => {
		let best = TextSelection.atStart(document).from;
		for (const range of ranges) {
			if (offset < range.start) break;
			if (offset >= range.end) {
				best = range.to;
				continue;
			}
			if (!range.node.isText) return TextSelection.near(document.resolve(range.from)).from;
			const text = range.node.text!;
			const json = range.node.toJSON() as JSONContent;
			const parent = range.parent ? { type: range.parent.type.name } : undefined;
			let low = 0,
				high = text.length,
				count = 0,
				predicted = range.start;
			while (low <= high) {
				const middle = Math.floor((low + high) / 2);
				const mapped =
					range.start + markdown.renderNodeToMarkdown({ ...json, text: text.slice(0, middle) }, parent).length;
				if (mapped <= offset) {
					count = middle;
					predicted = mapped;
					low = middle + 1;
				} else high = middle - 1;
			}
			best = range.from + count;
			// Containers may add pipe escapes or indentation; ordinary text runs use the direct mapping.
			range.encodedLength ??= markdown.renderNodeToMarkdown(json, parent).length;
			if (
				range.end - range.start === range.encodedLength ||
				projectComposerDocument(document, best).cursorOffset === predicted
			)
				return best;
			low = range.from;
			high = range.to;
			best = range.from;
			while (low <= high) {
				const middle = Math.floor((low + high) / 2);
				if (projectComposerDocument(document, middle).cursorOffset <= offset) {
					best = middle;
					low = middle + 1;
				} else high = middle - 1;
			}
			return best;
		}
		return TextSelection.near(document.resolve(best)).from;
	};
}

export function parseComposerMarkdown(text: string, schema: Schema = composerSchema): ProseMirrorNode {
	const parsed = markdown.parse(text);
	// An empty Markdown document still needs the schema's initial text block.
	return parsed.content?.length ? schema.nodeFromJSON(parsed) : schema.topNodeType.createAndFill()!;
}

export function composerDocumentFromDraft(
	draft: SessionDraft,
	label: (context: DraftContext) => string,
	useMarkdown = true,
	schema?: Schema,
): ProseMirrorNode {
	const remaining = new Map(
		draftContexts(draft).map((context) => [contextKey({ kind: context.kind, id: context.value.id }), context]),
	);
	const contexts: { context: DraftContext; offset?: number }[] = [];
	for (const position of draft.contextPositions ?? []) {
		const context = remaining.get(contextKey(position));
		if (!context) throw new Error("Draft context position has no matching item");
		contexts.push({ context, offset: position.offset });
		remaining.delete(contextKey(position));
	}
	contexts.push(...[...remaining.values()].map((context) => ({ context })));
	const source = useMarkdown ? parseComposerMarkdown(draft.text, schema) : parsePlainComposerText(draft.text, schema);
	const transform = new Transform(source);
	const positionAt = draft.contextPositions?.length
		? useMarkdown
			? createMarkdownPositionMapper(source)
			: createPlainPositionMapper(source)
		: null;
	for (const { context, offset } of contexts) {
		const position = offset === undefined ? TextSelection.atEnd(source).from : positionAt!(offset);
		const mapped = transform.mapping.map(position, 1);
		transform.insert(mapped, source.type.schema.nodes.composerContext!.create({ context, label: label(context) }));
	}
	return transform.doc;
}

/** Keep only the latest document projection; selection and React updates often read the same transaction. */
export function createComposerProjection(useMarkdown = true) {
	let last: { document: ProseMirrorNode; caret: number; projection: ComposerProjection } | undefined;
	return (document: ProseMirrorNode, caret: number): ComposerProjection => {
		if (last?.document === document && last.caret === caret) return last.projection;
		const projection = useMarkdown
			? projectComposerDocument(document, caret)
			: projectPlainComposerDocument(document, caret);
		last = { document, caret, projection };
		return projection;
	};
}

export function draftFromComposerProjection(projection: ComposerProjection): SessionDraft {
	return {
		text: projection.text,
		contextPositions: projection.contextPositions,
		attachments: projection.contexts.flatMap((context) => (context.kind === "image" ? [context.value] : [])),
		fileReferences: projection.contexts.flatMap((context) => (context.kind === "file" ? [context.value] : [])),
		pastedBlocks: projection.contexts.flatMap((context) => (context.kind === "paste" ? [context.value] : [])),
		reviewComments: projection.contexts.flatMap((context) => (context.kind === "review" ? [context.value] : [])),
	};
}
