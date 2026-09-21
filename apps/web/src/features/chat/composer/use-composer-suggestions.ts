import type { SessionRef } from "@ling/contracts/session-ref";
import type { CompletionPanelProps } from "@renderer/components/ui/completion-panel";
import { commandCatalogSnapshotFamily } from "@renderer/features/sessions/state/session";
import { useCompletionPopover } from "@renderer/hooks/use-completion-popover";
import { useAtomValue } from "jotai";
import { useCallback, useMemo, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { ComposerEditorHandle } from "./composer-editor";
import { slashTokenAt, spliceCompletionToken } from "./composer-completion-tokens";
import { SLASH_COMMANDS, type SlashCommandContext } from "./slash-commands";
import { searchCompletions } from "./completion-search";
import { useComposerCompletions } from "./use-composer-completions";
import type { useComposerAttachments } from "./use-composer-attachments";
import { useProjectMentionCompletions } from "./use-project-completions";

interface ComposerSuggestionOptions {
	draftKey: string;
	sessionRef: SessionRef;
	runtimeBinding: { runtimeId: string | null; generation: number };
	text: string;
	setInputText: (value: string) => boolean;
	editorRef: RefObject<ComposerEditorHandle | null>;
	commands: SlashCommandContext;
	onCommandError: (message: string) => void;
	createProjectFileReference: ReturnType<typeof useComposerAttachments>["createProjectFileReference"];
}

/** Orders Ling and Pi suggestion sources and applies the same selected row that the popover displays. */
export function useComposerSuggestions({
	draftKey,
	sessionRef,
	runtimeBinding,
	text,
	setInputText,
	editorRef,
	commands,
	onCommandError,
	createProjectFileReference,
}: ComposerSuggestionOptions) {
	const { t } = useTranslation();
	const catalog = useAtomValue(commandCatalogSnapshotFamily(draftKey))?.catalog ?? null;
	const composerInputRevisionRef = useRef(0);
	const composerTextRef = useRef(text);
	if (composerTextRef.current !== text) {
		composerTextRef.current = text;
		composerInputRevisionRef.current += 1;
	}
	const setText = useCallback(
		(value: string): boolean => {
			const accepted = setInputText(value);
			if (accepted && composerTextRef.current !== value) {
				composerTextRef.current = value;
				composerInputRevisionRef.current += 1;
			}
			return accepted;
		},
		[setInputText],
	);

	const [cursorOffset, setCursorOffsetState] = useState(0);
	const {
		listId,
		available,
		onFocus,
		onBlur,
		setActiveIndex,
		activeIndexFor,
		resetActiveIndex,
		interceptPopoverKey,
		focusEditorAt,
	} = useCompletionPopover(editorRef, text, cursorOffset);
	const composerCursorOffsetRef = useRef(cursorOffset);
	const setCursorOffset = useCallback((value: number) => {
		if (composerCursorOffsetRef.current !== value) {
			composerCursorOffsetRef.current = value;
			composerInputRevisionRef.current += 1;
		}
		setCursorOffsetState(value);
	}, []);
	const commandArgumentRequest = useMemo(() => {
		if (!catalog) return null;
		const textBeforeCursor = text.slice(0, cursorOffset);
		const currentLineBeforeCursor = textBeforeCursor.split("\n").at(-1) ?? "";
		const match = currentLineBeforeCursor.match(/^\/([\w:-]+)\s+([\s\S]*)$/);
		const commandName = match?.[1];
		if (!commandName) return null;
		const command = catalog.extensions.find((entry) => entry.name === commandName);
		if (!command?.hasArgumentCompletions) return null;
		return { commandName, argumentPrefix: match[2] ?? "" };
	}, [catalog, text, cursorOffset]);
	const {
		extensionAutocompleteItems,
		commandArgumentCompletionItems,
		applyExtensionCompletion,
		applyCommandArgumentCompletion,
		clearCompletions,
	} = useComposerCompletions({
		draftKey,
		sessionRef,
		runtimeBinding,
		text,
		cursorOffset,
		commandArgumentRequest,
		onCommandError,
		composerInputRevisionRef,
		composerTextRef,
		composerCursorOffsetRef,
		editorRef,
		setText,
		setCursorOffset,
	});

	// Pi session commands from the SDK. Extension commands, skills, and prompt templates are
	// ordinary message text here; pi expands or executes them inside session.prompt().
	// Triggers resolve the token under the cursor. No mentions inside a slash-command draft:
	// the command's own argument completion owns "@" for its whole line.
	const slashToken = slashTokenAt(text, cursorOffset);
	const mentionCompletions = useProjectMentionCompletions({
		cwd: text.startsWith("/") ? null : sessionRef.cwd,
		text,
		cursorOffset,
	});
	const mentionToken = mentionCompletions.token;

	const slashQuery = slashToken?.query.toLowerCase() ?? "";
	const dynamicMatches = useMemo(() => {
		if (slashToken === null || !catalog) return [];
		const entries = [
			...catalog.extensions.map((command) => ({
				kind: "extension" as const,
				name: command.name,
				description: command.description ?? "",
				insertText: `/${command.name} `,
			})),
			...catalog.skills.map((skill) => ({
				kind: "skill" as const,
				name: `skill:${skill.name}`,
				description: skill.description,
				insertText: `/skill:${skill.name} `,
			})),
			...catalog.prompts.map((prompt) => ({
				kind: "prompt" as const,
				name: prompt.name,
				description: prompt.description,
				argumentHint: prompt.argumentHint ?? undefined,
				insertText: `/${prompt.name} `,
			})),
		];
		return searchCompletions(entries, slashQuery);
	}, [slashToken, catalog, slashQuery]);
	const slashItems = [
		...searchCompletions(
			slashToken
				? SLASH_COMMANDS.map((command) => ({
						name: command.name,
						description: t(command.descriptionKey),
						kind: "command" as const,
						argumentHint: command.needsArg ? t("completion.nameArgument") : undefined,
						immediate: !command.needsArg,
						command,
					}))
				: [],
			slashQuery,
		),
		...dynamicMatches.map((entry) => ({ ...entry, command: undefined })),
	];
	const mentionItems = mentionCompletions.items;
	/** One ordered source for both display and selection, first non-empty wins. Mention items
	 * are never mixed with Pi's generic autocomplete: only Ling's file index can create the
	 * file-reference chip, and mixing the two made one visible row require multiple Enters.
	 * An @ token with zero Ling matches (e.g. `@agent:reviewer`) falls through to extensions. */
	const completionSource =
		slashItems.length > 0
			? ({ kind: "slash", items: slashItems } as const)
			: commandArgumentCompletionItems.length > 0
				? ({ kind: "commandArgument", items: commandArgumentCompletionItems } as const)
				: mentionItems.length > 0
					? ({ kind: "mention", items: mentionItems } as const)
					: ({ kind: "extension", items: extensionAutocompleteItems } as const);
	const completionItems = completionSource.items;
	const completionOpen = available && (completionItems.length > 0 || slashToken !== null || mentionToken !== null);
	const activeIndex = activeIndexFor(completionItems.length);
	const completionPanel: CompletionPanelProps = {
		id: listId,
		open: completionOpen,
		items: completionItems,
		activeIndex,
		onActiveChange: setActiveIndex,
		onSelect: selectCompletionItem,
		mode: slashToken
			? "command"
			: completionSource.kind === "mention" || (mentionToken && completionItems.length === 0)
				? "file"
				: "suggestion",
		loading: slashToken ? catalog === null : mentionCompletions.loading,
		error: mentionCompletions.error,
		onRetry: mentionCompletions.retry,
	};

	function selectCompletionItem(index: number) {
		if (completionSource.kind === "mention") {
			const entry = mentionItems[index];
			if (!entry) return;
			if (mentionToken === null) return;
			const reference = createProjectFileReference(
				entry.mentionPath,
				entry.kind === "directory" ? { directory: true } : undefined,
			);
			if (!reference) return;
			clearCompletions();
			editorRef.current?.insertContext({ kind: "file", value: reference }, mentionToken);
			return;
		}
		if (completionSource.kind === "commandArgument") {
			applyCommandArgumentCompletion(index);
			return;
		}
		if (completionSource.kind === "extension") {
			applyExtensionCompletion(index);
			return;
		}
		const item = slashItems[index];
		if (!item) return;
		if (slashToken === null) return;
		if (item.command) {
			if (item.command.needsArg) {
				const next = spliceCompletionToken(text, slashToken, `/${item.command.name} `);
				setText(next.text);
				setCursorOffset(next.cursorOffset);
				focusEditorAt(next.cursorOffset);
			} else {
				// Running a command consumes the whole draft (matching submit-path semantics);
				// leaving text behind would silently send it as the next bare message.
				setText("");
				setCursorOffset(0);
				focusEditorAt(0);
				item.command.run(commands, "");
			}
			return;
		}
		// SDK command/skill/template: complete the command text; Enter then sends it as a
		// normal message and pi performs the execution/expansion.
		const next = spliceCompletionToken(text, slashToken, item.insertText ?? "");
		setText(next.text);
		setCursorOffset(next.cursorOffset);
		focusEditorAt(next.cursorOffset);
	}

	return {
		setText,
		setCursorOffset,
		resetActiveIndex,
		focusEditorAt,
		clearCompletions,
		completionPanel,
		completionInput: {
			onFocus,
			onBlur,
			completion: completionOpen
				? { listId, activeId: completionItems[activeIndex] ? `${listId}-${activeIndex}` : undefined }
				: undefined,
		},
		interceptCompletionKey: (event: KeyboardEvent) =>
			interceptPopoverKey(
				event,
				completionItems.length,
				selectCompletionItem,
				completionOpen,
				completionPanel.error ? completionPanel.onRetry : undefined,
			),
	};
}
