import { useEditor, EditorContent, ReactNodeViewRenderer, NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { Extension, type Editor, type Extensions } from "@tiptap/core";
import { Markdown } from "@tiptap/markdown";
import Placeholder from "@tiptap/extension-placeholder";
import { NodeSelection, TextSelection, Plugin } from "@tiptap/pm/state";
import { closeHistory } from "@tiptap/pm/history";
import { useCallback, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from "react";
import { useTranslation } from "react-i18next";
import { draftFitsLimits, parseDraftContext, type SessionDraft } from "@renderer/features/sessions/state/drafts";
import { MarkdownImage } from "@renderer/components/markdown-image";
import { MarkdownImageRootContext } from "@renderer/components/markdown-image-root";
import { SESSION_MESSAGE_TEXT_MAX_CHARS } from "@ling/contracts/session";
import { contextKey, draftContexts, type DraftContext } from "@renderer/features/sessions/state/draft-context";
import { cn } from "@renderer/lib/utils";
import {
	composerDocumentFromDraft,
	composerExtensions,
	plainComposerExtensions,
	createPlainPositionMapper,
	parsePlainComposerText,
	createComposerProjection,
	createMarkdownPositionMapper,
	draftFromComposerProjection,
	parseComposerMarkdown,
} from "./composer-markdown";
import "./composer-editor.css";
import { ComposerFormattingToolbar } from "./composer-formatting-toolbar";
import { ComposerContextPreview } from "./composer-context-preview";
import { ComposerInlineAlert } from "./composer-shell";
import { sameComposerDraft, syncComposerProjection } from "./composer-editor-sync";
import { mergedPastedLength, PASTED_TEXT_BLOCK_MIN_CHARS } from "../../sessions/state/pasted-text";

const COMPOSER_DRAFT_SYNC = "composerDraftSync";

export interface ComposerEditorHandle {
	read(): { text: string; cursorOffset: number; selectionEnd: number };
	focus(offset?: number): void;
	insertContext(context: DraftContext, range?: { start: number; end: number }): void;
}

export interface ComposerEditorProps {
	contextEnabled?: boolean;
	projectCwd?: string | null | undefined;
	autofocus?: boolean;
	onFocus?: () => void;
	onBlur?: () => void;
	draft: SessionDraft;
	ref?: Ref<ComposerEditorHandle> | undefined;
	onChange: (draft: SessionDraft, cursorOffset: number) => void;
	onSelectionChange: (cursorOffset: number) => void;
	onKeyDown: (event: globalThis.KeyboardEvent) => void;
	onPaste: (event: globalThis.ClipboardEvent) => void;
	onOpenContext: (context: DraftContext) => void;
	onLimit: () => void;
	ariaInvalid: boolean;
	ariaErrorMessageId?: string | undefined;
	completion?: { listId: string; activeId?: string | undefined } | undefined;
	placeholder?: string | undefined;
	className?: string | undefined;
}

function ComposerImage({ node }: NodeViewProps) {
	return (
		<NodeViewWrapper as="span" className="composer-markdown-image" contentEditable={false}>
			<MarkdownImage src={node.attrs.src as string} alt={node.attrs.alt as string | undefined} />
		</NodeViewWrapper>
	);
}

export function ComposerEditor(props: ComposerEditorProps & { markdown: boolean }) {
	const createPositionMapper = props.markdown ? createMarkdownPositionMapper : createPlainPositionMapper;
	const parseText = props.markdown ? parseComposerMarkdown : parsePlainComposerText;
	const { t } = useTranslation();
	const placeholder = props.placeholder ?? t("session.composerPlaceholder");
	const copy = useRef({ placeholder, contextLimit: t("composerFormat.contextLimit") });
	copy.current = { placeholder, contextLimit: t("composerFormat.contextLimit") };
	const latest = useRef(props);
	latest.current = props;
	const accepted = useRef(props.draft);
	const initialized = useRef(false);
	const pendingFocus = useRef<{ offset: number | undefined } | null>(null);
	const [preview, setPreview] = useState<DraftContext | null>(null);
	const [contextError, setContextError] = useState<string | null>(null);
	const openContext = (context: DraftContext) => {
		if (context.kind === "file") latest.current.onOpenContext(context);
		else setPreview(context);
	};
	const projectionRef = useRef<ReturnType<typeof createComposerProjection> | null>(null);
	projectionRef.current ??= createComposerProjection(props.markdown);
	const project = projectionRef.current;
	const publishEditorState = useCallback(
		(current: Editor) => {
			syncComposerProjection(
				project(current.state.doc, current.state.selection.head),
				accepted,
				latest.current.onChange,
				latest.current.onSelectionChange,
			);
		},
		[project],
	);
	const label = (context: DraftContext): string => {
		switch (context.kind) {
			case "file":
				return `@${context.value.path}`;
			case "image":
				return t("composerFormat.image");
			case "paste":
				return t("session.pastedTextChip", { count: context.value.text.length });
			case "review":
				return `${context.value.filePath} ${context.value.rangeLabel}`;
		}
	};
	const labelRef = useRef(label);
	labelRef.current = label;
	const [extensions] = useState<Extensions>(() => [
		...((props.markdown ? composerExtensions : plainComposerExtensions) as Extensions).map((extension) => {
			if (extension.name === "image")
				return extension.extend({ addNodeView: () => ReactNodeViewRenderer(ComposerImage) });
			if (extension.name !== "composerContext") return extension;
			return extension.configure({
				projectCwd: () => latest.current.projectCwd ?? null,
				parseContext: (raw: string, sourceCwd: string | null) => {
					const context = parseDraftContext(raw);
					if (!context || latest.current.contextEnabled === false) return null;
					// A relative reference must keep its original project when pasted into another composer.
					if (context.kind === "file" && context.value.scope === "project" && sourceCwd !== latest.current.projectCwd) {
						if (!sourceCwd) return null;
						return {
							kind: "file",
							value: {
								id: crypto.randomUUID(),
								scope: "external",
								path: `${sourceCwd.replace(/[/\\]+$/, "")}/${context.value.path}`,
							},
						};
					}
					context.value.id = crypto.randomUUID();
					return context;
				},
			});
		}),
		...(props.markdown ? [Markdown.configure({ markedOptions: { gfm: true, breaks: true } })] : []),
		Placeholder.configure({ placeholder: () => copy.current.placeholder }),
		Extension.create({
			name: "composerBudget",
			addProseMirrorPlugins() {
				return [
					new Plugin({
						filterTransaction(transaction) {
							if (!transaction.docChanged) return true;
							const draft = draftFromComposerProjection(project(transaction.doc, transaction.selection.head));
							if (draftFitsLimits(draft)) return true;
							if (draft.text.length > SESSION_MESSAGE_TEXT_MAX_CHARS) latest.current.onLimit();
							else setContextError(copy.current.contextLimit);
							return false;
						},
					}),
				];
			},
		}),
	]);
	const editor = useEditor({
		extensions,
		enableInputRules: props.markdown,
		enablePasteRules: props.markdown,
		immediatelyRender: false,
		shouldRerenderOnTransaction: false,
		onCreate({ editor: current }) {
			// A deferred editor may finish loading after its workspace was hidden.
			const request = pendingFocus.current ?? (latest.current.autofocus ? { offset: undefined } : null);
			pendingFocus.current = null;
			if (!request || current.view.dom.closest("[inert]")) return;
			if (request.offset === undefined) current.commands.focus();
			else current.chain().setTextSelection(createPositionMapper(current.state.doc)(request.offset)).focus().run();
		},
		onFocus: () => latest.current.onFocus?.(),
		onBlur: () => latest.current.onBlur?.(),
		editorProps: {
			attributes: {
				role: "textbox",
				"aria-autocomplete": "list",
				"aria-haspopup": "listbox",
				"aria-multiline": "true",
				"aria-label": t("session.composerLabel"),
				class: "composer-prosemirror",
			},
			handleTextInput(view, from, to, text) {
				// Native replacement/dictation can deliver a whole string. Tiptap mark input rules
				// assume a typed suffix already exists in the document and can address invalid ranges.
				if (text.length <= 1 || view.composing) return false;
				view.dispatch(view.state.tr.insertText(text, from, to));
				return true;
			},
			handleKeyDown(view, event) {
				if (view.composing) return false;
				if (
					event.key === "Enter" &&
					view.state.selection instanceof NodeSelection &&
					view.state.selection.node.type.name === "composerContext"
				) {
					openContext(view.state.selection.node.attrs.context as DraftContext);
					return true;
				}
				// Enter inside a code block or list edits that block; the modifier send shortcut still submits.
				if (
					props.markdown &&
					event.key === "Enter" &&
					!event.metaKey &&
					!event.ctrlKey &&
					(view.state.selection.$from.parent.type.name !== "paragraph" || view.state.selection.$from.depth > 1)
				)
					return false;
				latest.current.onKeyDown(event);
				if (!props.markdown && event.key === "Enter" && !event.defaultPrevented) {
					view.dispatch(view.state.tr.insertText("\n").scrollIntoView());
					return true;
				}
				return event.defaultPrevented;
			},
			handlePaste(view, event) {
				latest.current.onPaste(event);
				if (event.defaultPrevented) return true;
				const clipboard = event.clipboardData;
				if (!clipboard || clipboard.files.length > 0) return false;
				const html = clipboard.getData("text/html");
				// Native HTML paste preserves marks, tables and inline context from another rich editor.
				if (
					html &&
					(props.markdown || html.includes("data-ling-context")) &&
					(latest.current.contextEnabled !== false || !html.includes("data-ling-context"))
				)
					return false;
				const text = clipboard.getData("text/plain");
				if (text.length === 0 || view.state.selection.$from.parent.type.name === "codeBlock") return false;
				if (
					latest.current.contextEnabled !== false &&
					text.length >= PASTED_TEXT_BLOCK_MIN_CHARS &&
					mergedPastedLength(accepted.current.text.length, accepted.current.pastedBlocks, text.length) <=
						SESSION_MESSAGE_TEXT_MAX_CHARS
				) {
					const context: DraftContext = { kind: "paste", value: { id: crypto.randomUUID(), text } };
					view.dispatch(
						closeHistory(view.state.tr)
							.replaceSelectionWith(
								view.state.schema.nodes.composerContext!.create({ context, label: labelRef.current(context) }),
							)
							.scrollIntoView(),
					);
					return true;
				}
				const content = parseText(text, view.state.schema);
				view.dispatch(view.state.tr.replaceSelection(content.slice(0, content.content.size)).scrollIntoView());
				return true;
			},
			handleClickOn(_view, _position, node, _nodePosition, event, direct) {
				if (!direct || node.type.name !== "composerContext") return false;
				event.preventDefault();
				openContext(node.attrs.context as DraftContext);
				return true;
			},
		},
		onUpdate({ editor: current }) {
			setContextError(null);
			publishEditorState(current);
		},
		onSelectionUpdate({ editor: current, transaction }) {
			// A loaded draft is published with its normalized text after the transaction is accepted.
			if (transaction.getMeta(COMPOSER_DRAFT_SYNC)) return;
			latest.current.onSelectionChange(project(current.state.doc, current.state.selection.head).cursorOffset);
		},
	});

	useImperativeHandle(
		props.ref,
		() => ({
			read() {
				if (!editor || editor.isDestroyed) return { text: accepted.current.text, cursorOffset: 0, selectionEnd: 0 };
				const current = project(editor.state.doc, editor.state.selection.from);
				const end = editor.state.selection.empty
					? current.cursorOffset
					: project(editor.state.doc, editor.state.selection.to).cursorOffset;
				return { text: current.text, cursorOffset: current.cursorOffset, selectionEnd: end };
			},
			focus(offset) {
				if (!editor || editor.isDestroyed) {
					pendingFocus.current = { offset };
					return;
				}
				if (editor.view.dom.closest("[inert]")) return;
				if (offset === undefined) editor.commands.focus();
				else editor.chain().setTextSelection(createPositionMapper(editor.state.doc)(offset)).focus().run();
			},
			insertContext(context, range) {
				if (!editor || editor.isDestroyed) return;
				const transaction = closeHistory(editor.state.tr);
				if (range) {
					const positionAt = createPositionMapper(transaction.doc);
					transaction.setSelection(
						TextSelection.create(transaction.doc, positionAt(range.start), positionAt(range.end)),
					);
				}
				transaction.replaceSelectionWith(
					editor.schema.nodes.composerContext!.create({ context, label: labelRef.current(context) }),
				);
				editor.view.dispatch(transaction.scrollIntoView());
				editor.commands.focus();
			},
		}),
		[editor, project, createPositionMapper],
	);

	useLayoutEffect(() => {
		if (!editor || editor.isDestroyed) return;
		if (!initialized.current) {
			initialized.current = true;
			accepted.current = props.draft;
			const doc = composerDocumentFromDraft(props.draft, labelRef.current, props.markdown, editor.schema);
			editor
				.chain()
				.setMeta(COMPOSER_DRAFT_SYNC, true)
				.setMeta("addToHistory", false)
				.setContent(doc.toJSON(), { emitUpdate: false })
				.run();
			// Publish normalization even if selection stayed put; a budget-rejected document must retain its draft.
			if (editor.state.doc.eq(doc)) publishEditorState(editor);
			return;
		}
		if (sameComposerDraft(accepted.current, props.draft)) return;
		const previous = accepted.current;
		accepted.current = props.draft;
		if (previous.text !== props.draft.text) {
			const cursor = project(editor.state.doc, editor.state.selection.head).cursorOffset;
			const doc = composerDocumentFromDraft(props.draft, labelRef.current, props.markdown, editor.schema);
			editor
				.chain()
				.setMeta(COMPOSER_DRAFT_SYNC, true)
				.setContent(doc.toJSON(), { emitUpdate: false })
				.setTextSelection(createPositionMapper(doc)(Math.min(cursor, props.draft.text.length)))
				.run();
			if (!editor.state.doc.eq(doc)) return;
			publishEditorState(editor);
			return;
		}
		const wanted = new Map(
			draftContexts(props.draft).map((context) => [contextKey({ kind: context.kind, id: context.value.id }), context]),
		);
		const transaction = closeHistory(editor.state.tr);
		editor.state.doc.descendants((node, position) => {
			if (node.type.name !== "composerContext") return;
			const context = node.attrs.context as DraftContext;
			const key = contextKey({ kind: context.kind, id: context.value.id });
			const replacement = wanted.get(key);
			if (!replacement)
				transaction.delete(transaction.mapping.map(position), transaction.mapping.map(position + node.nodeSize));
			else if (replacement.value !== context.value)
				transaction.setNodeMarkup(transaction.mapping.map(position), undefined, {
					context: replacement,
					label: labelRef.current(replacement),
				});
			wanted.delete(key);
		});
		for (const context of wanted.values()) {
			const node = editor.schema.nodes.composerContext!.create({ context, label: labelRef.current(context) });
			const selection = TextSelection.near(transaction.doc.resolve(transaction.selection.to));
			transaction.setSelection(selection).replaceSelectionWith(node);
		}
		if (transaction.docChanged) editor.view.dispatch(transaction);
	}, [editor, props.draft, project, props.markdown, createPositionMapper, publishEditorState]);

	useLayoutEffect(() => {
		if (!editor || editor.isDestroyed) return;
		// Refresh decorations and context labels without remounting or resetting the draft/history.
		const transaction = editor.state.tr.setMeta("addToHistory", false).setMeta(COMPOSER_DRAFT_SYNC, true);
		editor.state.doc.descendants((node, position) => {
			if (node.type.name !== "composerContext") return;
			const nextLabel = labelRef.current(node.attrs.context as DraftContext);
			if (nextLabel !== node.attrs.label)
				transaction.setNodeMarkup(position, undefined, { ...node.attrs, label: nextLabel });
		});
		if (transaction.docChanged) editor.view.dispatch(transaction);
		else editor.view.updateState(editor.state);
	}, [editor, placeholder, t]);

	useLayoutEffect(() => {
		if (!editor || editor.isDestroyed) return;
		editor.view.dom.setAttribute("aria-invalid", String(props.ariaInvalid));
		if (props.ariaInvalid && props.ariaErrorMessageId)
			editor.view.dom.setAttribute("aria-errormessage", props.ariaErrorMessageId);
		else editor.view.dom.removeAttribute("aria-errormessage");
	}, [editor, props.ariaInvalid, props.ariaErrorMessageId]);

	useLayoutEffect(() => {
		if (!editor || editor.isDestroyed) return;
		const element = editor.view.dom;
		if (props.completion) element.setAttribute("aria-controls", props.completion.listId);
		else element.removeAttribute("aria-controls");
		if (props.completion?.activeId) element.setAttribute("aria-activedescendant", props.completion.activeId);
		else element.removeAttribute("aria-activedescendant");
	}, [editor, props.completion]);

	if (!editor) return <div className="min-h-12" aria-busy="true" />;
	return (
		<MarkdownImageRootContext.Provider value={props.projectCwd ?? null}>
			<div className={cn("composer-editor", props.className)}>
				<ComposerContextPreview
					context={preview}
					label={preview ? label(preview) : ""}
					onClose={() => setPreview(null)}
					onExpand={() => {
						if (preview?.kind !== "paste") return;
						const content = parseText(preview.value.text, editor.schema);
						editor.state.doc.descendants((node, position) => {
							if (
								node.type.name === "composerContext" &&
								(node.attrs.context as DraftContext).value.id === preview.value.id
							) {
								editor.view.dispatch(
									editor.state.tr.replaceWith(position, position + node.nodeSize, content.content).scrollIntoView(),
								);
							}
						});
						setPreview(null);
						editor.commands.focus();
					}}
				/>
				{props.markdown && <ComposerFormattingToolbar editor={editor} />}
				<EditorContent editor={editor} />
				{contextError && <ComposerInlineAlert message={contextError} />}
			</div>
		</MarkdownImageRootContext.Provider>
	);
}
