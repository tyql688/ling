import { useWorkbenchLayout } from "@renderer/components/workbench/workbench-layout-context";
import { useReadingWorkspace } from "./reading-state";
import { useDomainApi } from "@renderer/lib/host-api-context";
import type { ProjectFileReferenceTarget } from "@ling/contracts/project";
import type { SendMode } from "@ling/contracts/session";
import type { ImageAttachment } from "@ling/contracts/session-messages";
import { useSessionChat } from "@renderer/features/chat/use-session-chat";
import { useReviewWorkspace } from "@renderer/features/review/use-review-workspace";
import { useApproval } from "@renderer/features/sessions/use-approval";
import { useExtensionUiPrompt } from "@renderer/features/sessions/use-extension-ui-prompt";
import { latestContextTokens } from "@renderer/features/usage/workspace-session-usage";
import { WorkspaceConversation } from "@renderer/features/workspace/workspace-conversation";
import { useCommandFeedback } from "@renderer/hooks/use-command-feedback";
import { archivedTranscriptsAtom } from "@renderer/features/sessions/archived-session-state";
import { useAtomValue } from "jotai";
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useWorkspaceDialogs } from "./use-workspace-dialogs";
import { useWorkspaceFileActions } from "./workspace-file-actions";
import { useWorkspaceReviewActions } from "./workspace-review-actions";
import {
	useWorkspaceField,
	useWorkspaceOwner,
	workspaceModelFeedbackAtom,
	workspaceSelectionAtom,
	workspaceSessionActionsAtom,
} from "./workspace-state";
export function WorkspaceSessionConversation() {
	const hostSessionApi = useDomainApi("session");
	const hostUiApi = useDomainApi("ui");

	const sessionController = useWorkspaceField(workspaceSelectionAtom, "sessionController");
	const activeSessionRef = useWorkspaceField(workspaceSelectionAtom, "activeSessionRef");
	const [reading, setReading] = useReadingWorkspace(activeSessionRef);
	const { floating, setComposerHeight } = useWorkbenchLayout();
	const activeSession = useWorkspaceField(workspaceSelectionAtom, "activeSession");
	const activeSessionKey = useWorkspaceField(workspaceSelectionAtom, "activeSessionKey");
	const runtimeSessionRef = useWorkspaceField(workspaceSelectionAtom, "runtimeSessionRef");
	const activeSessionIsChild = useWorkspaceField(workspaceSelectionAtom, "activeSessionIsChild");
	const activeParentSession = useWorkspaceField(workspaceSelectionAtom, "activeParentSession");
	const modelSwitchNoticeVisible = useWorkspaceField(workspaceModelFeedbackAtom, "modelSwitchNoticeVisible");
	const showModelSwitchNotice = useWorkspaceField(workspaceModelFeedbackAtom, "showModelSwitchNotice");
	const clearModelSwitchNotice = useWorkspaceField(workspaceModelFeedbackAtom, "clearModelSwitchNotice");
	const handleCurrentProviderChange = useWorkspaceField(workspaceModelFeedbackAtom, "handleCurrentProviderChange");
	const showCommandError = useCommandFeedback();
	const { showComposerCommandError, openComposerFileReference } = useWorkspaceFileActions();
	const { openSessionFileReview, openTurnReview } = useWorkspaceReviewActions();
	const dialogs = useWorkspaceDialogs();
	const sessionActions = useWorkspaceOwner(workspaceSessionActionsAtom);
	const { t } = useTranslation();

	const archivedTranscripts = useAtomValue(archivedTranscriptsAtom);
	const archived = activeSessionKey === null ? undefined : archivedTranscripts.get(activeSessionKey);
	const archivedSession = activeSessionKey !== null && archivedTranscripts.has(activeSessionKey);

	const {
		messages,
		busy,
		summarizationRetry,
		queue,
		extensionUiState,
		transcriptReady,
		transcriptHistoryReady,
		historyLoad,
		send,
		abort,
	} = useSessionChat(runtimeSessionRef);

	const {
		pending: extensionUiPrompt,
		pendingCount: extensionUiPromptCount,
		respond: respondToExtensionUiPrompt,
	} = useExtensionUiPrompt(runtimeSessionRef);

	const {
		pending: approvalPrompt,
		pendingCount: approvalPromptCount,
		respond: respondToApprovalPrompt,
	} = useApproval(runtimeSessionRef);

	const handleComposerSend = useCallback(
		(text: string, mode: SendMode, images?: ImageAttachment[], fileReferences?: ProjectFileReferenceTarget[]) => {
			clearModelSwitchNotice();
			return send(text, mode, images, fileReferences);
		},
		[clearModelSwitchNotice, send],
	);

	const lastContextTokens = useMemo(() => latestContextTokens(messages), [messages]);
	const { review: changeReview } = useReviewWorkspace();
	const {
		queuedEdit,
		composerFocusRequestId,
		handleFork,
		handleForkWhole,
		handleEditMessage,
		handleRenameSession,
		handleCompact,
		startQueuedEdit,
		cancelQueuedEdit,
		saveQueuedEdit,
	} = sessionActions;
	const { selectSession } = sessionController;
	if (!activeSessionRef || !activeSessionKey) return null;
	// An archived session has no runtime; its transcript comes from the session file and renders
	// through the same timeline, without a composer.
	if (!runtimeSessionRef && !archivedSession) return null;
	const readOnlyAction = () => showComposerCommandError(t("archivedSession.readOnly"));
	return (
		<WorkspaceConversation
			floating={
				floating
					? {
							historyOpen: reading.historyExpanded,
							onFooterHeightChange: setComposerHeight,
							title: activeSession?.title ?? t("session.conversationLog"),
							onToggle: () => setReading((current) => ({ ...current, historyExpanded: !current.historyExpanded })),
						}
					: undefined
			}
			sessionRef={activeSessionRef}
			sessionKey={activeSessionKey}
			archived={archivedSession}
			messages={archived ? archived.messages : messages}
			busy={archivedSession ? false : busy}
			summarizationRetry={archivedSession ? null : summarizationRetry}
			transcriptReady={archivedSession ? archived !== undefined : transcriptReady}
			historyLoad={historyLoad}
			hydrationOverlay={false}
			usageReady={transcriptHistoryReady}
			extensionUi={extensionUiState}
			queue={queue}
			changeReviewTurns={changeReview.timelineTurns}
			onRevertTurn={(turnId) => dialogs.requestRevertTurn(activeSessionRef, turnId)}
			onOpenTurnReview={openTurnReview}
			onOpenSessionFileReview={openSessionFileReview}
			queueActions={{
				disabled: queuedEdit !== null,
				startEdit: startQueuedEdit,
				edit: (kind, index, expectedRevision, expectedText, text) =>
					void hostSessionApi
						.editQueued({
							ref: activeSessionRef,
							kind,
							index,
							expectedRevision,
							expectedText,
							text,
						})
						.catch(showCommandError),
				promote: (index, expectedRevision, expectedText) =>
					void hostSessionApi
						.promoteQueued({ ref: activeSessionRef, index, expectedRevision, expectedText })
						.catch(showCommandError),
			}}
			onRetryTurn={
				activeSessionIsChild || archivedSession
					? undefined
					: (entryId) => {
							void hostSessionApi.retryTurn({ ref: activeSessionRef, entryId }).catch(showCommandError);
						}
			}
			onFork={(entryId) => (archivedSession ? readOnlyAction() : void handleFork(entryId).catch(showCommandError))}
			onEditMessage={(entryId, newText) =>
				activeSessionIsChild || archivedSession
					? showComposerCommandError(archivedSession ? t("archivedSession.readOnly") : t("session.childReadOnlyRetry"))
					: void handleEditMessage(entryId, newText).catch(showCommandError)
			}
			approvalPrompt={approvalPrompt}
			approvalPromptCount={approvalPromptCount}
			onRespondApproval={respondToApprovalPrompt}
			extensionUiPrompt={extensionUiPrompt}
			extensionUiPromptCount={extensionUiPromptCount}
			onRespondExtensionUi={respondToExtensionUiPrompt}
			modelSwitchNoticeVisible={modelSwitchNoticeVisible}
			childSession={Boolean(activeSessionIsChild)}
			parentSession={activeParentSession}
			composerFocusRequestId={composerFocusRequestId}
			onSend={handleComposerSend}
			onAbort={abort}
			onMidConversationModelChange={showModelSwitchNotice}
			onCurrentProviderChange={handleCurrentProviderChange}
			onOpenFileReference={openComposerFileReference}
			canOpenFileReference={(reference) => reference.scope === "project" || hostUiApi.capabilities.nativePathReveal}
			queuedEdit={queuedEdit}
			onSaveQueuedEdit={saveQueuedEdit}
			onCancelQueuedEdit={cancelQueuedEdit}
			onRenameSession={(title) => void handleRenameSession(activeSessionRef, title).catch(showCommandError)}
			onCompactSession={() => void handleCompact()}
			onComposerCommandError={showComposerCommandError}
			contextTokens={lastContextTokens}
			onOpenSession={(ref) => void selectSession(ref).catch(showCommandError)}
			onContinueInFork={(ref) => void handleForkWhole(ref).catch(showCommandError)}
		/>
	);
}
