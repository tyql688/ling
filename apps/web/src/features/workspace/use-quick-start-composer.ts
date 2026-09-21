import { fileReferenceTarget } from "@renderer/features/sessions/state/composer-file-references";
import type { DraftContext } from "@renderer/features/sessions/state/draft-context";
import { useDomainApi } from "@renderer/lib/host-api-context";
import { useQuickStartModels } from "./use-quick-start-models";
import type { CompletionPanelProps } from "@renderer/components/ui/completion-panel";
import { searchCompletions } from "@renderer/features/chat/composer/completion-search";

import type { OpenProjectInfo } from "@ling/contracts/project";

import { SESSION_MESSAGE_TEXT_MAX_CHARS, type ThinkingLevel } from "@ling/contracts/session";

import type { ImageAttachment } from "@ling/contracts/session-messages";

import type { MessageFileReference } from "@ling/contracts/file-reference-text";

import { slashTokenAt, spliceCompletionToken } from "@renderer/features/chat/composer/composer-completion-tokens";

import type { ComposerEditorHandle } from "@renderer/features/chat/composer/composer-editor";

import { useAttachmentDrop } from "@renderer/features/chat/composer/use-attachment-drop";

import { useComposerAttachments } from "@renderer/features/chat/composer/use-composer-attachments";

import { useComposerCore, useComposerKeyboard } from "@renderer/features/chat/composer/use-composer-core";

import {
	useProjectMentionCompletions,
	useProjectSkillCompletions,
} from "@renderer/features/chat/composer/use-project-completions";

import { composerFocusRequestIdAtom } from "@renderer/lib/navigation-state";
import { lastConversationCwdAtom } from "@renderer/features/projects/state";

import { prepareComposerMessage } from "@renderer/features/sessions/state/composer-message";

import { NEW_CONVERSATION_DRAFT_KEY, type SessionDraft } from "@renderer/features/sessions/state/drafts";

import { useSessionDraft } from "@renderer/features/sessions/state/use-session-draft";

import { useBoundedTextInput } from "@renderer/hooks/use-bounded-text-input";

import { useCompletionPopover } from "@renderer/hooks/use-completion-popover";

import { useImeGuard } from "@renderer/hooks/use-ime-guard";

import { formatRequestError } from "@renderer/lib/errors";

import { sendShortcutAtom } from "@renderer/lib/preferences/composer";

import { useAtom, useAtomValue } from "jotai";

import { useEffect, useId, useRef, useState } from "react";

import { useTranslation } from "react-i18next";

/** Stable empty array while the project's model list has not loaded yet. */

export interface QuickStartOptions {
	/** Project the new conversation runs in — a project is always required. */
	cwd: string;
	/** null → Pi's default model for the new session. */
	model: { provider: string; id: string } | null;
	/** null → the session keeps Pi's resolved default thinking level. */
	thinkingLevel: ThinkingLevel | null;
	/** null → text-only first message. */
	images: ImageAttachment[] | null;
	fileReferences: MessageFileReference[];
	/** Renderer draft form retained until the first send is accepted. */
	draft: SessionDraft;
}
export type QuickStartComposerProps = {
	/** Folder-backed projects offered as start targets. */
	projects: OpenProjectInfo[];
	/** Project selected by a project-scoped "new conversation" action. */
	preferredCwd: string | null;
	onAddProject: () => Promise<OpenProjectInfo | null>;
	onQuickStart: (text: string, options: QuickStartOptions) => Promise<void>;
};

/** Owns the form's asynchronous work, recovery state and submission intent. */
export function useQuickStartComposer({ projects, preferredCwd, onAddProject, onQuickStart }: QuickStartComposerProps) {
	const hostUiApi = useDomainApi("ui");
	const hostProjectApi = useDomainApi("project");

	const { t } = useTranslation();
	const textLimitErrorId = useId();
	const {
		draft,
		setDraft,
		setText: setTextValue,
		setAttachments,
		setFileReferences,
		snapshot: snapshotDraft,
		clear: clearDraft,
		restore: restoreDraft,
	} = useSessionDraft(NEW_CONVERSATION_DRAFT_KEY);
	const { text } = draft;
	const {
		limitExceeded: textLimitExceeded,
		resetLimitExceeded,
		reportLimitExceeded,
		setBoundedValue: setText,
	} = useBoundedTextInput(setTextValue, SESSION_MESSAGE_TEXT_MAX_CHARS);
	const [targetCwd, setTargetCwd] = useState<string | null>(preferredCwd);
	const focusRequest = useAtomValue(composerFocusRequestIdAtom);
	useEffect(() => setTargetCwd(preferredCwd), [preferredCwd, focusRequest]);
	const [error, setError] = useState<string | null>(null);
	const [cursorOffset, setCursorOffset] = useState(0);
	const ime = useImeGuard();
	const editorRef = useRef<ComposerEditorHandle>(null);
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
	// Explicit UI default: with no manual pick or scope, the new conversation targets
	// the project the LAST conversation started in (persisted preference), then the
	// first open project. A conversation can never start without a project.
	const [lastConversationCwd, setLastConversationCwd] = useAtom(lastConversationCwdAtom);
	const targetProject =
		targetCwd !== null
			? (projects.find((project) => project.cwd === targetCwd) ?? null)
			: (projects.find((project) => project.cwd === lastConversationCwd) ?? projects[0] ?? null);
	const {
		attachments,
		attachmentIssue,
		addFiles,
		handlePaste,
		fileReferences,
		fileReferenceIssue,
		createProjectFileReference,
	} = useComposerAttachments(
		targetProject?.cwd ?? null,
		targetProject?.cwd ?? "quick-start",
		[draft.attachments, setAttachments],
		[draft.fileReferences, setFileReferences],
	);
	const { dropActive, dropHandlers } = useAttachmentDrop(addFiles);
	const previousProject = useRef(targetProject?.cwd);
	useEffect(() => {
		if (previousProject.current !== targetProject?.cwd) {
			previousProject.current = targetProject?.cwd;
			setFileReferences([]);
		}
	}, [targetProject?.cwd, setFileReferences]);
	const sendShortcut = useAtomValue(sendShortcutAtom);

	const {
		model,
		modelOptions,
		pickedThinkingLevel,
		modelPillLabel,
		effectiveThinkingLevel,
		selectModel,
		selectThinking,
		setupError,
		modelsLoaded,
		skillCommandsEnabled,
		retrySetup,
		displayModel,
		displayThinkingLevels,
		displayThinkingLevel,
	} = useQuickStartModels(targetProject?.cwd ?? null);
	const readyToSubmit = targetProject !== null && modelsLoaded && setupError === null && modelOptions.length > 0;
	const visibleError = error ?? setupError;
	// Same trigger rules as the session composer: token under the cursor, and a slash-command
	// draft suppresses @ completion for its whole line.
	const slashToken = slashTokenAt(text, cursorOffset);
	const mentionCompletions = useProjectMentionCompletions({
		cwd: text.startsWith("/") ? null : (targetProject?.cwd ?? null),
		text,
		cursorOffset,
	});
	// The skill-directory scan is paid only once the user actually opens the slash popover.
	const slashActive = slashToken !== null;
	const [slashUsed, setSlashUsed] = useState(false);
	useEffect(() => {
		if (slashActive) setSlashUsed(true);
	}, [slashActive]);
	const projectSkills = useProjectSkillCompletions({
		cwd: targetProject?.cwd ?? null,
		enabled: skillCommandsEnabled && slashUsed,
	});
	const slashQuery = slashToken?.query.toLowerCase() ?? "";
	const slashItems = slashToken === null ? [] : searchCompletions(projectSkills.items, slashQuery);
	const completionSource =
		slashItems.length > 0
			? ({ kind: "skill", items: slashItems } as const)
			: ({ kind: "mention", items: mentionCompletions.items } as const);
	const completionItems = completionSource.items;
	const completionOpen =
		available && targetProject !== null && (slashToken !== null || mentionCompletions.token !== null);
	const activeIndex = activeIndexFor(completionItems.length);
	const completionPanel: CompletionPanelProps = {
		id: listId,
		open: completionOpen,
		items: completionItems,
		activeIndex,
		onActiveChange: setActiveIndex,
		onSelect: selectCompletionItem,
		mode: slashToken ? "skill" : "file",
		loading: slashToken ? projectSkills.loading : mentionCompletions.loading,
		error: slashToken ? projectSkills.error : mentionCompletions.error,
		onRetry: slashToken ? projectSkills.retry : mentionCompletions.retry,
	};

	function selectCompletionItem(index: number): void {
		if (completionSource.kind === "mention") {
			const item = mentionCompletions.items[index];
			const token = mentionCompletions.token;
			if (!item || token === null) return;
			const reference = createProjectFileReference(
				item.mentionPath,
				item.kind === "directory" ? { directory: true } : undefined,
			);
			if (!reference) return;
			resetActiveIndex();
			editorRef.current?.insertContext({ kind: "file", value: reference }, token);
			return;
		}
		const item = slashItems[index];
		if (!item || slashToken === null) return;
		const next = spliceCompletionToken(text, slashToken, item.insertText);
		if (!setText(next.text)) return;
		setCursorOffset(next.cursorOffset);
		resetActiveIndex();
		focusEditorAt(next.cursorOffset);
	}

	const core = useComposerCore<SessionDraft>({
		adapter: {
			text,
			attachmentCount: attachments.length,
			fileReferenceCount: fileReferences.length,
			hasExtraContent: draft.pastedBlocks.length > 0 || draft.reviewComments.length > 0,
			snapshot: snapshotDraft,
			clear: () => {
				setError(null);
				clearDraft();
			},
			restore: restoreDraft,
		},
		validate: () => {
			if (targetProject === null) {
				setError(t("project.unavailable"));
				return false;
			}
			return readyToSubmit;
		},
		prepare: prepareComposerMessage,
		onPreparationError: (cause) => setError(formatRequestError(cause)),
		onLimitError: () => setError(t("session.messageTextLimit", { count: SESSION_MESSAGE_TEXT_MAX_CHARS })),
		submit: (message, snapshot) => {
			const outgoingText = message.text;
			const images = message.images.length > 0 ? message.images : null;
			// validate already confirmed targetProject is non-null; the draft* fields carry the pre-submit snapshot for the parent to keep.
			if (targetProject === null) return Promise.reject(new Error("Quick start target project is missing"));
			// Remember the project so the next global new-conversation defaults to it.
			setLastConversationCwd(targetProject.cwd);
			return onQuickStart(outgoingText, {
				cwd: targetProject.cwd,
				model: model ? { provider: model.provider, id: model.id } : null,
				thinkingLevel: pickedThinkingLevel === null ? null : effectiveThinkingLevel,
				images,
				fileReferences: message.fileReferences,
				draft: snapshot,
			});
		},
		onSubmitError: (cause) => setError(formatRequestError(cause)),
	});
	const submitting = core.pendingAction !== null;

	const handleKeyDown = useComposerKeyboard({
		isComposing: ime.isNativeComposing,
		sendShortcut,
		text,
		intercept: (event) =>
			interceptPopoverKey(
				event,
				completionItems.length,
				selectCompletionItem,
				completionOpen,
				completionPanel.error ? completionPanel.onRetry : undefined,
			),
		onSubmit: () => core.requestSubmit(),
	});
	const changeDraft = (nextDraft: SessionDraft, selectionStart: number) => {
		resetLimitExceeded();
		setDraft(nextDraft);
		setCursorOffset(selectionStart);
		resetActiveIndex();
	};
	const openContext = (context: DraftContext) => {
		if (context.kind === "file" && targetProject && hostUiApi.capabilities.nativePathReveal)
			void hostProjectApi
				.revealFileReference({ cwd: targetProject.cwd, reference: fileReferenceTarget(context.value) })
				.catch((cause: unknown) => setError(formatRequestError(cause)));
	};
	const addProject = () => {
		void onAddProject()
			.then((added) => {
				if (added) setTargetCwd(added.cwd);
			})
			.catch((cause: unknown) => setError(formatRequestError(cause)));
	};
	return {
		displayModel,
		displayThinkingLevels,
		displayThinkingLevel,
		setupError,
		modelsLoaded,
		readyToSubmit,
		retrySetup,
		draft,
		changeDraft,
		openContext,
		selectModel,
		selectThinking,
		addProject,
		dropActive,
		dropHandlers,
		completionPanel,
		completionInput: {
			onFocus,
			onBlur,
			completion: completionOpen
				? { listId, activeId: completionItems[activeIndex] ? `${listId}-${activeIndex}` : undefined }
				: undefined,
		},
		modelOptions,
		submitting,
		attachmentIssue,
		fileReferenceIssue,
		textLimitExceeded,
		textLimitErrorId,
		t,
		targetProject,
		editorRef,
		setCursorOffset,
		handleKeyDown,
		handlePaste,
		reportLimitExceeded,
		addFiles,
		modelPillLabel,
		core,
		visibleError,
		projects,
		setTargetCwd,
	};
}
