import type { PendingFileReference } from "@ling/contracts/draft";
import type { ProjectFileReferenceTarget } from "@ling/contracts/project";
import type {
	ApprovalRequest,
	ExtensionUiRequest,
	SendMode,
	SessionQueue,
	SessionSummary,
	SummarizationRetryStatus,
} from "@ling/contracts/session";
import type { ExtensionUiStateSnapshot } from "@ling/contracts/session-extension-ui";
import type { ImageAttachment, SessionMessage } from "@ling/contracts/session-messages";
import type { SessionRef } from "@ling/contracts/session-ref";
import { MarkdownImageRootContext } from "@renderer/components/markdown-image-root";
import { FeedbackNotice } from "@renderer/components/ui/feedback";
import { Composer } from "@renderer/features/chat/composer/composer";
import type { QueueActions } from "@renderer/features/chat/composer/queued-bubble";
import { ApprovalPromptCard } from "@renderer/features/chat/extension-ui/approval-prompt-card";
import { ExtensionUiPromptCard } from "@renderer/features/chat/extension-ui/extension-ui-prompt-card";
import { ChatTimeline, type FloatingConversation } from "@renderer/features/chat/transcript/transcript-timeline";
import type { TranscriptHistoryLoad } from "@renderer/features/chat/transcript/use-transcript-history";
import type { ChangeReviewTurn } from "@renderer/features/review/turn-changes-card";
import type { QueuedEditState } from "@renderer/features/workspace/workspace-session-actions";
import { WorkspaceTimelineFooter } from "@renderer/features/workspace/workspace-session-footer";

import { type ReactNode, useMemo } from "react";
import { useTranslation } from "react-i18next";

export function WorkspaceConversation(props: {
	floating?: FloatingConversation | undefined;
	historyLoad: TranscriptHistoryLoad;
	sessionRef: SessionRef;
	sessionKey: string;
	messages: SessionMessage[];
	busy: boolean;
	summarizationRetry: SummarizationRetryStatus | null;
	/** False until the first transcript history attempt settles. */
	transcriptReady: boolean;
	/** Whether the timeline draws its own hydration indicator; the workspace pane owns one instead. */
	hydrationOverlay?: boolean;
	/** False while the session transcript still awaits snapshot/full-history hydrate. */
	usageReady: boolean;
	extensionUi: ExtensionUiStateSnapshot;
	queue: SessionQueue;
	changeReviewTurns: ChangeReviewTurn[] | null;
	onRevertTurn: (turnId: string) => void;
	onOpenTurnReview: (turnId: string | null, path?: string) => void;
	onOpenSessionFileReview: (path: string) => void;
	queueActions: QueueActions;
	onFork: (forkEntryId: string) => void;
	onRetryTurn?: ((entryId: string) => void) | undefined;
	onEditMessage: (entryId: string, newText: string) => void;
	approvalPrompt: ApprovalRequest | null;
	approvalPromptCount: number;
	onRespondApproval: (approved: boolean) => Promise<void>;
	extensionUiPrompt: ExtensionUiRequest | null;
	extensionUiPromptCount: number;
	onRespondExtensionUi: (value: string | null) => Promise<void>;
	modelSwitchNoticeVisible: boolean;
	childSession: boolean;
	/** Read straight from the session file: the transcript renders normally, with no composer. */
	archived?: boolean;
	parentSession: SessionSummary | undefined;
	composerFocusRequestId: number;
	onSend: (
		text: string,
		mode: SendMode,
		images?: ImageAttachment[],
		fileReferences?: ProjectFileReferenceTarget[],
	) => Promise<void>;
	onAbort: () => Promise<void>;
	onMidConversationModelChange: () => void;
	onCurrentProviderChange: (sessionKey: string, provider: string | null) => void;
	onOpenFileReference: (reference: PendingFileReference) => void;
	canOpenFileReference: (reference: PendingFileReference) => boolean;
	queuedEdit: QueuedEditState | null;
	onSaveQueuedEdit: (
		text: string,
		images: ImageAttachment[],
		fileReferences: ProjectFileReferenceTarget[],
	) => Promise<void>;
	onCancelQueuedEdit: () => void;
	onRenameSession: (title: string) => void;
	onCompactSession: () => void;
	onComposerCommandError: (message: string) => void;
	contextTokens: number | undefined;
	onOpenSession: (ref: SessionRef) => void;
	onContinueInFork: (ref: SessionRef) => void;
}) {
	const { t } = useTranslation();
	const hasConversationHistory = useMemo(
		() => props.messages.some((message) => message.role === "user" || message.role === "assistant"),
		[props.messages],
	);

	const footer = props.archived ? null : (
		<WorkspaceTimelineFooter
			childSession={
				props.childSession
					? {
							ref: props.sessionRef,
							...(props.parentSession === undefined ? {} : { parent: props.parentSession }),
						}
					: null
			}
			parentComposer={
				<>
					<Composer
						sessionRef={props.sessionRef}
						focusRequestId={props.composerFocusRequestId}
						busy={props.busy}
						hasConversationHistory={hasConversationHistory}
						onSend={props.onSend}
						onAbort={props.onAbort}
						onMidConversationModelChange={props.onMidConversationModelChange}
						onCurrentProviderChange={props.onCurrentProviderChange}
						onOpenFileReference={props.onOpenFileReference}
						canOpenFileReference={props.canOpenFileReference}
						{...(props.queuedEdit && props.queuedEdit.sessionKey === props.sessionKey
							? {
									queuedEdit: {
										kind: props.queuedEdit.kind,
										attachmentScopeKey: props.queuedEdit.attachmentScopeKey,
										onSave: props.onSaveQueuedEdit,
										onCancel: props.onCancelQueuedEdit,
									},
								}
							: {})}
						commands={{
							renameSession: props.onRenameSession,
							compactSession: props.onCompactSession,
						}}
						onCommandError={props.onComposerCommandError}
						contextTokens={props.contextTokens}
						messages={props.messages}
						usageReady={props.usageReady}
					/>
				</>
			}
			onOpenSession={props.onOpenSession}
			onContinueInFork={props.onContinueInFork}
		/>
	);

	const footerOverlay: ReactNode = props.approvalPrompt ? (
		<ApprovalPromptCard
			key={props.approvalPrompt.requestId}
			request={props.approvalPrompt}
			pendingCount={props.approvalPromptCount}
			onRespond={props.onRespondApproval}
		/>
	) : props.extensionUiPrompt ? (
		<ExtensionUiPromptCard
			key={props.extensionUiPrompt.requestId}
			request={props.extensionUiPrompt}
			pendingCount={props.extensionUiPromptCount}
			onRespond={props.onRespondExtensionUi}
		/>
	) : !props.modelSwitchNoticeVisible ? null : (
		<FeedbackNotice tone="info" className="max-w-full rounded-control px-2.5 py-1.5 text-xs shadow-sm">
			<span className="min-w-0 truncate">{t("session.modelSwitchNotice")}</span>
		</FeedbackNotice>
	);

	// Markdown images in this transcript resolve against the session's project.
	return (
		<MarkdownImageRootContext.Provider value={props.sessionRef.cwd}>
			<ChatTimeline
				floating={props.floating}
				historyLoad={props.historyLoad}
				hydrationOverlay={props.hydrationOverlay ?? true}
				sessionKey={props.sessionKey}
				transcriptReady={props.transcriptReady}
				historyReady={props.usageReady}
				messages={props.messages}
				busy={props.busy}
				summarizationRetry={props.summarizationRetry}
				toolsExpanded={props.extensionUi.toolsExpanded}
				hiddenThinkingLabel={props.extensionUi.hiddenThinkingLabel}
				extensionUi={props.extensionUi}
				queue={props.queue}
				changeReviewTurns={props.changeReviewTurns}
				onRevertTurn={props.onRevertTurn}
				onOpenTurnReview={props.onOpenTurnReview}
				onOpenSessionFileReview={props.onOpenSessionFileReview}
				queueActions={props.queueActions}
				onFork={props.onFork}
				onEditMessage={props.onEditMessage}
				onRetryTurn={props.onRetryTurn}
				footerOverlay={footerOverlay}
				footer={footer}
			/>
		</MarkdownImageRootContext.Provider>
	);
}
