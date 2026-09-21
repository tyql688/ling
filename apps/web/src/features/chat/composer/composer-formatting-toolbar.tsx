import { useEditorState, type Editor } from "@tiptap/react";
import { Bold, Italic, Code, List, ListChecks, Quote, Undo2, Redo2, Ellipsis } from "lucide-react";
import { useTranslation } from "react-i18next";
import { TooltipIconButton } from "@renderer/components/ui/tooltip-icon-button";
import { IconButton } from "@renderer/components/ui/icon-button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";

export function ComposerFormattingToolbar({ editor }: { editor: Editor }) {
	const { t } = useTranslation();
	const active = useEditorState({
		editor,
		selector: ({ editor: current }) => ({
			bold: current.isActive("bold"),
			italic: current.isActive("italic"),
			code: current.isActive("codeBlock"),
			list: current.isActive("bulletList"),
			task: current.isActive("taskList"),
			quote: current.isActive("blockquote"),
			table: current.isActive("table"),
			undo: current.can().undo(),
			redo: current.can().redo(),
		}),
	});
	const actions = [
		{ key: "bold", icon: Bold, pressed: active.bold, run: () => editor.chain().focus().toggleBold().run() },
		{ key: "italic", icon: Italic, pressed: active.italic, run: () => editor.chain().focus().toggleItalic().run() },
		{ key: "code", icon: Code, pressed: active.code, run: () => editor.chain().focus().toggleCodeBlock().run() },
		{ key: "list", icon: List, pressed: active.list, run: () => editor.chain().focus().toggleBulletList().run() },
		{ key: "task", icon: ListChecks, pressed: active.task, run: () => editor.chain().focus().toggleTaskList().run() },
		{ key: "quote", icon: Quote, pressed: active.quote, run: () => editor.chain().focus().toggleBlockquote().run() },
		{ key: "undo", icon: Undo2, disabled: !active.undo, run: () => editor.chain().focus().undo().run() },
		{ key: "redo", icon: Redo2, disabled: !active.redo, run: () => editor.chain().focus().redo().run() },
	];
	const moreActions = [
		{ key: "paragraph", run: () => editor.chain().focus().setParagraph().run() },
		{ key: "heading1", run: () => editor.chain().focus().toggleHeading({ level: 1 }).run() },
		{ key: "heading2", run: () => editor.chain().focus().toggleHeading({ level: 2 }).run() },
		{ key: "heading3", run: () => editor.chain().focus().toggleHeading({ level: 3 }).run() },
		{ key: "orderedList", run: () => editor.chain().focus().toggleOrderedList().run() },
		{ key: "strike", run: () => editor.chain().focus().toggleStrike().run() },
		{ key: "inlineCode", run: () => editor.chain().focus().toggleCode().run() },
		{ key: "divider", run: () => editor.chain().focus().setHorizontalRule().run() },
	];
	const tableActions = active.table
		? [
				{ key: "addRow", run: () => editor.chain().focus().addRowAfter().run() },
				{ key: "addColumn", run: () => editor.chain().focus().addColumnAfter().run() },
				{ key: "deleteRow", run: () => editor.chain().focus().deleteRow().run() },
				{ key: "deleteColumn", run: () => editor.chain().focus().deleteColumn().run() },
				{ key: "deleteTable", run: () => editor.chain().focus().deleteTable().run() },
			]
		: [
				{
					key: "table",
					run: () => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
				},
			];
	return (
		<div className="flex items-center gap-0.5 px-0.5" role="group" aria-label={t("composerFormat.label")}>
			{actions.map(({ key, icon: Icon, pressed, disabled, run }) => (
				<TooltipIconButton
					key={key}
					type="button"
					label={t(`composerFormat.${key}`)}
					aria-pressed={pressed}
					disabled={disabled}
					onMouseDown={(event) => event.preventDefault()}
					onClick={run}
					className={pressed ? "bg-surface-hover text-text-primary" : undefined}
				>
					<Icon className="size-3.5" />
				</TooltipIconButton>
			))}
			<DropdownMenu>
				<DropdownMenuTrigger
					render={<IconButton type="button" aria-label={t("composerFormat.more")} title={t("composerFormat.more")} />}
				>
					<Ellipsis className="size-3.5" />
				</DropdownMenuTrigger>
				<DropdownMenuContent side="top">
					{moreActions.map(({ key, run }) => (
						<DropdownMenuItem key={key} onClick={run}>
							{t(`composerFormat.${key}`)}
						</DropdownMenuItem>
					))}
					<DropdownMenuSeparator />
					{tableActions.map(({ key, run }) => (
						<DropdownMenuItem key={key} onClick={run}>
							{t(`composerFormat.${key}`)}
						</DropdownMenuItem>
					))}
				</DropdownMenuContent>
			</DropdownMenu>
			<span className="ml-auto select-none px-1 text-xs text-text-muted">Markdown</span>
		</div>
	);
}
