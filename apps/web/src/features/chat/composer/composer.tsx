import { ModelConnectionPrompt } from "@renderer/features/models/model-connection-prompt";
import type { PendingFileReference } from "@ling/contracts/draft";
import { type SendMode, SESSION_MESSAGE_TEXT_MAX_CHARS } from "@ling/contracts/session";
import type { ImageAttachment, SessionMessage } from "@ling/contracts/session-messages";
import type { MessageFileReference } from "@ling/contracts/file-reference-text";
import { sessionKey, type SessionRef } from "@ling/contracts/session-ref";
import { useAttachmentDrop } from "@renderer/features/chat/composer/use-attachment-drop";
import { useComposerAttachments } from "@renderer/features/chat/composer/use-composer-attachments";

import type { SessionDraft } from "@renderer/features/sessions/state/drafts";
import { sessionTranscriptStateFamily } from "@renderer/features/sessions/state/session";
import { useSessionDraft } from "@renderer/features/sessions/state/use-session-draft";
import { SessionUsageDialog } from "@renderer/features/usage/session-usage-dialog";
import { deriveContextUsage } from "@renderer/features/usage/workspace-session-usage";
import { useBoundedTextInput } from "@renderer/hooks/use-bounded-text-input";
import { useImeGuard } from "@renderer/hooks/use-ime-guard";
import { formatRequestError } from "@renderer/lib/errors";
import { followUpBehaviorAtom, sendShortcutAtom } from "@renderer/lib/preferences/composer";
import { useAtom, useAtomValue } from "jotai";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { prepareComposerMessage } from "../../sessions/state/composer-message";
import { AttachmentIssueMessage, FileReferenceIssueMessage } from "./attachment-issue-message";
import type { ComposerEditorHandle } from "./composer-editor";
import { ComposerInlineAlert } from "./composer-shell";
import { ComposerSurface } from "./composer-surface";
import { ComposerToolbar } from "./composer-toolbar";
import { CompletionPanel } from "@renderer/components/ui/completion-panel";
import type { SlashCommandContext } from "./slash-commands";
import { useComposerCore, useComposerKeyboard } from "./use-composer-core";
import { useComposerEditorMirror } from "./use-composer-editor-mirror";
import { shouldStartComposerHistoryNavigation, useComposerHistory } from "./use-composer-history";
import { useComposerSuggestions } from "./use-composer-suggestions";
import { useModelState } from "./use-model-state";
import { type QueuedComposerEdit, useSessionComposerActions } from "./use-session-composer-actions";

interface ComposerProps {
	sessionRef: SessionRef;
	focusRequestId: number;
	busy: boolean;
	hasConversationHistory: boolean;
	onSend: (
		text: string,
		mode: SendMode,
		images?: ImageAttachment[],
		fileReferences?: MessageFileReference[],
	) => Promise<void>;
	onAbort: () => Promise<void>;
	onMidConversationModelChange: () => void;
	onCurrentProviderChange?: ((sessionKey: string, provider: string | null) => void) | undefined;
	onOpenFileReference: (reference: PendingFileReference) => void;
	canOpenFileReference?: ((reference: PendingFileReference) => boolean) | undefined;
	queuedEdit?: QueuedComposerEdit;
	commands: SlashCommandContext;
	onCommandError: (message: string) => void;
	contextTokens?: number | undefined;
	messages: readonly SessionMessage[];
	usageReady: boolean;
}

export function Composer({
	sessionRef,
	focusRequestId,
	busy,
	hasConversationHistory,
	onSend,
	onAbort,
	onMidConversationModelChange,
	onCurrentProviderChange,
	onOpenFileReference,
	canOpenFileReference,
	queuedEdit,
	commands,
	onCommandError,
	contextTokens,
	messages,
	usageReady,
}: ComposerProps) {
	const { t } = useTranslation();
	const textLimitErrorId = useId();
	const draftKey = sessionKey(sessionRef);
	const {
		draft,
		setDraft,
		setText: setDraftText,
		setAttachments,
		setFileReferences,
		snapshot: snapshotDraft,
		clear: clearDraft,
		restore: restoreDraft,
	} = useSessionDraft(draftKey);
	const runtimeBinding = useAtomValue(sessionTranscriptStateFamily(draftKey));
	const { text, pastedBlocks, reviewComments } = draft;
	const {
		limitExceeded: textLimitExceeded,
		reportLimitExceeded,
		resetLimitExceeded: resetTextLimitExceeded,
		setBoundedValue,
	} = useBoundedTextInput(setDraftText, SESSION_MESSAGE_TEXT_MAX_CHARS);

	// draftKey resets feedback when the active session changes.
	useEffect(() => resetTextLimitExceeded(), [draftKey, resetTextLimitExceeded]);
	const {
		attachments,
		attachmentIssue,
		addFiles,
		handlePaste,
		fileReferences,
		fileReferenceIssue,
		createProjectFileReference,
	} = useComposerAttachments(
		sessionRef.cwd,
		queuedEdit ? `${draftKey}:queued:${queuedEdit.attachmentScopeKey}` : `${draftKey}:draft`,
		[draft.attachments, setAttachments],
		[draft.fileReferences, setFileReferences],
	);
	const { dropActive, dropHandlers } = useAttachmentDrop(addFiles);
	const [usageOpen, setUsageOpen] = useState(false);
	const {
		state: modelState,
		error: modelStateError,
		setModel,
		setThinkingLevel,
	} = useModelState(sessionRef, runtimeBinding);
	useLayoutEffect(() => {
		onCurrentProviderChange?.(draftKey, modelState?.currentProvider ?? null);
		return () => onCurrentProviderChange?.(draftKey, null);
	}, [draftKey, modelState?.currentProvider, onCurrentProviderChange]);
	const editorRef = useRef<ComposerEditorHandle>(null);
	const {
		setText,
		setCursorOffset,
		resetActiveIndex,
		focusEditorAt,
		clearCompletions,
		completionPanel,
		completionInput,
		interceptCompletionKey,
	} = useComposerSuggestions({
		draftKey,
		sessionRef,
		runtimeBinding,
		text,
		setInputText: setBoundedValue,
		editorRef,
		commands,
		onCommandError,
		createProjectFileReference,
	});
	const handledFocusRequestIdRef = useRef(focusRequestId);
	const ime = useImeGuard();
	const sendShortcut = useAtomValue(sendShortcutAtom);
	const [followUpBehavior, setFollowUpBehavior] = useAtom(followUpBehaviorAtom);
	/** What a plain send does while the agent is running (the follow-up-behavior preference). */
	const busyMode: SendMode = followUpBehavior === "steer" ? "steer" : "followUp";
	const editingQueuedMessage = queuedEdit !== undefined;

	useEffect(() => {
		if (handledFocusRequestIdRef.current === focusRequestId) return;
		handledFocusRequestIdRef.current = focusRequestId;
		const animationFrame = window.requestAnimationFrame(() => {
			const input = editorRef.current;
			if (input === null) return;
			input.focus(text.length);
			setCursorOffset(text.length);
		});
		return () => window.cancelAnimationFrame(animationFrame);
	}, [focusRequestId, setCursorOffset, text]);

	useEffect(() => {
		if (!editingQueuedMessage) return;
		editorRef.current?.focus();
	}, [editingQueuedMessage]);

	const setTextFromComposerHistory = useCallback(
		(value: string) => {
			setText(value);
			setCursorOffset(value.length);
			resetActiveIndex();
			clearCompletions();
			focusEditorAt(value.length);
		},
		[setText, setCursorOffset, resetActiveIndex, clearCompletions, focusEditorAt],
	);

	const { isNavigatingHistory, navigateComposerHistory, rememberLocalComposerHistory, resetComposerHistoryNavigation } =
		useComposerHistory({
			draftKey,
			cwd: sessionRef.cwd,
			text,
			onCommandError,
			applyText: setTextFromComposerHistory,
		});

	const core = useComposerCore<SessionDraft, SendMode>({
		adapter: {
			text,
			attachmentCount: attachments.length,
			fileReferenceCount: fileReferences.length,
			hasExtraContent: pastedBlocks.length > 0 || reviewComments.length > 0,
			snapshot: snapshotDraft,
			clear: () => {
				resetTextLimitExceeded();
				setText("");
				setCursorOffset(0);
				clearDraft();
			},
			restore: restoreDraft,
		},
		prepare: prepareComposerMessage,
		onPreparationError: (cause) => onCommandError(formatRequestError(cause)),
		onLimitError: () => onCommandError(t("session.messageTextLimit", { count: SESSION_MESSAGE_TEXT_MAX_CHARS })),
		// useSessionChat.send already owns the session error banner + sidebar Failed flag.
		// Do not also toast here — that produced two identical danger surfaces.
		submit: (message, _snapshot, mode) => {
			const { text: outgoingText, images, fileReferences } = message;
			return onSend(outgoingText, mode, images.length > 0 ? images : undefined, fileReferences);
		},
		onSubmitted: (submitted) => {
			if (submitted !== null) rememberLocalComposerHistory(submitted);
			resetComposerHistoryNavigation();
		},
	});
	useComposerEditorMirror(sessionRef, runtimeBinding, text, onCommandError);

	const { saveQueuedEdit, submitIntent, abortSession, submitFromKeyboard } = useSessionComposerActions({
		draftKey,
		core,
		text,
		setText,
		snapshotDraft,
		queuedEdit,
		commands,
		onCommandError,
		onAbort,
		busy,
		busyMode,
		sendShortcut,
	});
	const { pendingAction } = core;

	/** Session-side interception before the Enter check: history navigation and the completion popover; returning true means the event was consumed. */
	const interceptComposerKey = (event: globalThis.KeyboardEvent): boolean => {
		if (isNavigatingHistory() && event.key === "ArrowUp") {
			event.preventDefault();
			navigateComposerHistory("previous");
			return true;
		}
		if (isNavigatingHistory() && event.key === "ArrowDown") {
			event.preventDefault();
			navigateComposerHistory("next");
			return true;
		}
		if (interceptCompletionKey(event)) return true;
		if (event.key === "ArrowUp" && shouldStartComposerHistoryNavigation(event, editorRef.current?.read())) {
			event.preventDefault();
			navigateComposerHistory("previous");
			return true;
		}
		return false;
	};

	const handleKeyDown = useComposerKeyboard({
		isComposing: ime.isNativeComposing,
		sendShortcut,
		text,
		intercept: interceptComposerKey,
		onSubmit: submitFromKeyboard,
	});

	const currentModel = modelState?.models.find(
		(model) => model.provider === modelState.currentProvider && model.id === modelState.currentModelId,
	);
	const handleModelSelect = (provider: string, modelId: string) => {
		if (busy) return;
		if (currentModel?.provider === provider && currentModel.id === modelId) return;
		void setModel(provider, modelId).then((next) => {
			if (!next) return;
			if (hasConversationHistory) onMidConversationModelChange();
		});
	};
	const contextUsage = deriveContextUsage(contextTokens, currentModel?.contextWindow);
	const hasSendableContent = core.hasSendableContent;

	if (!busy && !modelStateError && modelState?.models.length === 0) return <ModelConnectionPrompt />;

	return (
		<div className="pb-5">
			<SessionUsageDialog
				open={usageOpen}
				onOpenChange={setUsageOpen}
				messages={messages}
				contextUsage={contextUsage}
				ready={usageReady}
			/>
			<ComposerSurface
				sessionRef={sessionRef}
				variant="session"
				dropActive={dropActive}
				dropHandlers={dropHandlers}
				popover={<CompletionPanel {...completionPanel} />}
				alerts={
					<>
						<AttachmentIssueMessage issue={attachmentIssue} className="px-1" />
						<FileReferenceIssueMessage issue={fileReferenceIssue} className="px-1" />
						{textLimitExceeded && (
							<ComposerInlineAlert
								id={textLimitErrorId}
								message={t("session.messageTextLimit", { count: SESSION_MESSAGE_TEXT_MAX_CHARS })}
							/>
						)}
					</>
				}
				banner={
					queuedEdit && (
						<div className="flex items-center justify-between gap-2 rounded-control bg-surface-hover px-2 py-1 text-xs text-text-muted">
							<span>
								{t(queuedEdit.kind === "steering" ? "session.queuedEditSteering" : "session.queuedEditFollowUp")}
							</span>
							<button
								type="button"
								onClick={queuedEdit.onCancel}
								className="min-h-6 rounded-sm px-1.5 py-0.5 hover:bg-surface-hover"
							>
								{t("session.queuedEditCancel")}
							</button>
						</div>
					)
				}
				editorKey={queuedEdit ? `${draftKey}:queued:${queuedEdit.attachmentScopeKey}` : draftKey}
				editorRef={editorRef}
				editor={{
					...completionInput,
					projectCwd: sessionRef.cwd,
					draft,
					ariaInvalid: textLimitExceeded,
					ariaErrorMessageId: textLimitErrorId,
					onChange: (nextDraft, selectionStart) => {
						resetComposerHistoryNavigation();
						resetTextLimitExceeded();
						setDraft(nextDraft);
						setCursorOffset(selectionStart);
						resetActiveIndex();
					},
					onKeyDown: handleKeyDown,
					onSelectionChange: setCursorOffset,
					onPaste: handlePaste,
					onLimit: reportLimitExceeded,
					onOpenContext: (context) => {
						if (context.kind === "file" && (canOpenFileReference?.(context.value) ?? true))
							onOpenFileReference(context.value);
					},
				}}
				footer={
					<ComposerToolbar
						projectPath={sessionRef.cwd}
						sessionRef={sessionRef}
						modelState={modelState}
						modelStateError={modelStateError}
						currentModel={currentModel ?? null}
						contextUsage={contextUsage}
						followUpBehavior={followUpBehavior}
						busy={busy}
						queuedEdit={queuedEdit !== undefined}
						hasSendableContent={hasSendableContent}
						pendingAction={pendingAction}
						onAttachFiles={(files) => void addFiles(files)}
						usageOpen={usageOpen}
						onOpenUsage={() => setUsageOpen(true)}
						onModelSelect={handleModelSelect}
						onThinkingLevelChange={(level) => void setThinkingLevel(level)}
						onFollowUpBehaviorChange={setFollowUpBehavior}
						onSaveQueuedEdit={() => void saveQueuedEdit()}
						onAbort={abortSession}
						onSubmit={() => submitIntent(busy ? busyMode : "prompt")}
					/>
				}
			/>
		</div>
	);
}
