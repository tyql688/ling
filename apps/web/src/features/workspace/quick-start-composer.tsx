import { ProjectVoiceInput } from "@renderer/features/pi-adapters/voice/voice-input";
import { ComposerAttachments } from "@renderer/features/chat/composer/composer-attachments";
import { ModelConnectionPrompt } from "@renderer/features/models/model-connection-prompt";
import { SettingsRetryAction } from "@renderer/components/ui/settings-state";
import { SESSION_MESSAGE_TEXT_MAX_CHARS } from "@ling/contracts/session";

import { Button } from "@renderer/components/ui/button";

import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";

import {
	AttachmentIssueMessage,
	FileReferenceIssueMessage,
} from "@renderer/features/chat/composer/attachment-issue-message";

import { ComposerInlineAlert } from "@renderer/features/chat/composer/composer-shell";

import { ComposerSurface } from "@renderer/features/chat/composer/composer-surface";

import { CompletionPanel } from "@renderer/components/ui/completion-panel";

import {
	ComposerToolbarFrame,
	ComposerFeatureControls,
	ComposerModelControls,
	ComposerActionButton,
} from "@renderer/features/chat/composer/composer-toolbar";

import { NEW_CONVERSATION_DRAFT_KEY } from "@renderer/features/sessions/state/drafts";

import { ChevronDown, Folder, FolderOpen } from "lucide-react";

import { type QuickStartComposerProps, useQuickStartComposer } from "./use-quick-start-composer";
import { useEffect } from "react";
import { useWorkspaceField, workspaceSessionActionsAtom } from "./workspace-state";

export function QuickStartComposer(props: QuickStartComposerProps) {
	const {
		setupError,
		modelsLoaded,
		readyToSubmit,
		retrySetup,
		draft,
		changeDraft,
		appendVoiceTranscript,
		openFile,
		selectModel,
		selectThinking,
		addProject,
		dropActive,
		dropHandlers,
		completionPanel,
		completionInput,
		modelOptions,
		defaultModel,
		submitting,
		attachmentIssue,
		addingAttachments,
		removeAttachment,
		removeFileReference,
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
		displayModel,
		modelPillLabel,
		displayThinkingLevel,
		displayThinkingLevels,
		core,
		visibleError,
		projects,
		setTargetCwd,
	} = useQuickStartComposer(props);
	const focusRequestId = useWorkspaceField(workspaceSessionActionsAtom, "composerFocusRequestId");
	useEffect(() => {
		editorRef.current?.focus();
	}, [editorRef, focusRequestId]);

	return (
		<ComposerSurface
			variant="home"
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
			attachments={
				<ComposerAttachments
					cwd={targetProject?.cwd ?? null}
					images={draft.attachments}
					files={draft.fileReferences}
					pending={addingAttachments}
					onRemoveImage={removeAttachment}
					onRemoveFile={removeFileReference}
					onOpenFile={openFile}
				/>
			}
			editorKey={NEW_CONVERSATION_DRAFT_KEY}
			editorRef={editorRef}
			editor={{
				...completionInput,
				autofocus: true,
				projectCwd: targetProject?.cwd,
				draft,
				ariaInvalid: textLimitExceeded,
				ariaErrorMessageId: textLimitErrorId,
				onChange: changeDraft,
				onKeyDown: handleKeyDown,
				onSelectionChange: setCursorOffset,
				onPaste: handlePaste,
				onLimit: reportLimitExceeded,
			}}
			editorClassName="px-1"
			footer={
				<ComposerToolbarFrame
					onAttachFiles={(files) => void addFiles(files)}
					features={targetProject ? <ComposerFeatureControls projectPath={targetProject.cwd} /> : null}
					leading={
						<DropdownMenu>
							<DropdownMenuTrigger
								render={
									<Button
										variant="ghost"
										size="sm"
										aria-label={t("session.pickFolder")}
										className="max-w-32 gap-1.5 px-1.5 font-normal text-text-muted hover:text-text-primary @min-[40rem]/composer:max-w-44"
									/>
								}
							>
								<Folder className="size-3.5" aria-hidden="true" />
								<span className="min-w-0 truncate">{targetProject ? targetProject.name : t("session.pickFolder")}</span>
								<ChevronDown className="size-3" aria-hidden="true" />
							</DropdownMenuTrigger>
							<DropdownMenuContent className="w-56" side="top">
								{projects.map((project) => (
									<DropdownMenuItem key={project.cwd} onClick={() => setTargetCwd(project.cwd)}>
										<Folder className="size-3.5" aria-hidden="true" />
										<span className="min-w-0 flex-1 truncate">{project.name}</span>
									</DropdownMenuItem>
								))}
								{projects.length > 0 && <DropdownMenuSeparator />}
								<DropdownMenuItem onClick={addProject}>
									<FolderOpen className="size-3.5" aria-hidden="true" />
									{t("session.pickFolder")}
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					}
					actions={
						<>
							{targetProject && (
								<ProjectVoiceInput cwd={targetProject.cwd} disabled={submitting} onTranscript={appendVoiceTranscript} />
							)}
							<ComposerActionButton
								pending={submitting}
								label={t(submitting ? "session.sending" : "session.send")}
								disabled={submitting || !core.hasSendableContent || !readyToSubmit}
								onClick={() => core.requestSubmit()}
							/>
						</>
					}
				>
					{!modelsLoaded && !setupError && (
						<span role="status" className="sr-only">
							{t("session.loadingModels")}
						</span>
					)}
					<ComposerModelControls
						options={modelOptions}
						selected={displayModel}
						defaultModel={defaultModel}
						modelLabel={modelPillLabel}
						thinkingLevel={displayThinkingLevel}
						thinkingLevels={displayThinkingLevels}
						modelDisabled={!readyToSubmit || submitting}
						thinkingDisabled={!readyToSubmit || submitting}
						projectPath={targetProject?.cwd ?? null}
						onModelSelect={(model) => {
							selectModel(model);
							editorRef.current?.focus();
						}}
						onThinkingLevelChange={selectThinking}
					/>
				</ComposerToolbarFrame>
			}
			trailing={
				<>
					{visibleError && (
						<div className="mt-2 border-border-subtle border-t pt-2">
							<ComposerInlineAlert message={visibleError} />
							{setupError && <SettingsRetryAction label={t("common.retry")} onClick={retrySetup} />}
						</div>
					)}
					{modelsLoaded && !setupError && modelOptions.length === 0 && <ModelConnectionPrompt compact />}
				</>
			}
		/>
	);
}
