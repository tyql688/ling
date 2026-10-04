import { type SendMode, SESSION_MESSAGE_TEXT_MAX_CHARS } from "@ling/contracts/session";
import type { ImageAttachment } from "@ling/contracts/session-messages";
import type { MessageFileReference } from "@ling/contracts/file-reference-text";
import type { SessionDraft } from "@renderer/features/sessions/state/drafts";
import { formatRequestError } from "@renderer/lib/errors";
import type { SendShortcut } from "@renderer/lib/preferences/composer";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { prepareComposerMessage } from "../../sessions/state/composer-message";
import { findSlashCommand, type SlashCommandContext, type SlashCommandDefinition } from "./slash-commands";
import type { ComposerCore } from "./use-composer-core";

export interface QueuedComposerEdit {
	kind: "steering" | "followUp";
	attachmentScopeKey: string;
	onSave: (text: string, images: ImageAttachment[], fileReferences: MessageFileReference[]) => Promise<void>;
	onCancel: () => void;
}

interface SessionComposerActionOptions {
	draftKey: string;
	core: ComposerCore<SendMode>;
	text: string;
	setText: (value: string) => boolean;
	snapshotDraft: () => SessionDraft;
	queuedEdit: QueuedComposerEdit | undefined;
	commands: SlashCommandContext;
	onCommandError: (message: string) => void;
	onAbort: () => Promise<void>;
	busy: boolean;
	busyMode: SendMode;
	sendShortcut: SendShortcut;
}

/** Resolves `/cmd rest` on submit: captures the command name and raw argument text (may span lines). */
const SLASH_COMMAND_LINE = /^\/(\w+)(?:\s+([\s\S]*))?$/;

/** Session submission intent, queue edits and stop share the generic composer's revision lock. */
export function useSessionComposerActions({
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
}: SessionComposerActionOptions) {
	const { t } = useTranslation();
	const { pendingAction, beginAction, finishAction, invalidateActions } = core;
	const currentOwner = useRef<string | null>(draftKey);
	currentOwner.current = draftKey;
	useEffect(() => {
		currentOwner.current = draftKey;
		return () => {
			currentOwner.current = null;
		};
	}, [draftKey]);

	// switching sessions invalidates an in-flight composer action.
	useEffect(() => invalidateActions(), [draftKey, invalidateActions]);

	// A prompt send resolves only after the entire Pi turn, but the busy transition already
	// proves the request was accepted. Release the transport lock so the running composer can
	// queue/steer or stop; invalidate the old completion so it cannot clear a newer action.
	const pendingActionRef = useRef(pendingAction);
	pendingActionRef.current = pendingAction;
	useEffect(() => {
		if (!busy || pendingActionRef.current !== "send") return;
		invalidateActions();
	}, [busy, invalidateActions]);

	const saveQueuedEdit = async () => {
		if (pendingActionRef.current !== null || !queuedEdit || !core.hasSendableContent) return;
		let prepared;
		try {
			prepared = prepareComposerMessage(snapshotDraft());
		} catch (cause) {
			onCommandError(formatRequestError(cause));
			return;
		}
		if (prepared.status === "empty") return;
		if (prepared.status === "tooLong") {
			onCommandError(t("session.messageTextLimit", { count: SESSION_MESSAGE_TEXT_MAX_CHARS }));
			return;
		}
		const { text, images, fileReferences } = prepared.message;
		const actionRevision = beginAction("save");
		if (actionRevision === null) return;
		try {
			await queuedEdit.onSave(text, images, fileReferences);
		} finally {
			finishAction(actionRevision);
		}
	};

	const runCommand = async (command: SlashCommandDefinition, arg: string) => {
		const revision = beginAction("send");
		if (revision === null) return;
		const submitted = snapshotDraft();
		try {
			await command.run(commands, arg);
			if (currentOwner.current === draftKey && snapshotDraft().text === submitted.text) setText("");
		} catch (cause) {
			if (currentOwner.current === draftKey) onCommandError(formatRequestError(cause, t));
		} finally {
			finishAction(revision);
		}
	};

	const submitIntent = (mode: SendMode) => {
		const commandLine = text.match(SLASH_COMMAND_LINE);
		const command = commandLine?.[1] ? findSlashCommand(commandLine[1]) : undefined;
		if (command) {
			const arg = (commandLine?.[2] ?? "").trim();
			if (command.needsArg && !arg) {
				// Keep an incomplete Host command in the draft so the user can finish its argument before sending.

				onCommandError(t("session.cmdNeedsArg", { name: command.name }));
				return;
			}
			void runCommand(command, arg);
			return;
		}
		core.requestSubmit(mode);
	};

	const abortSession = () => {
		if (pendingActionRef.current !== null) return;
		const actionRevision = beginAction("stop");
		if (actionRevision === null) return;
		// useSessionChat.abort reports abort failures in the session banner.
		void onAbort().finally(() => finishAction(actionRevision));
	};

	const submitFromKeyboard = (withCmd: boolean) => {
		if (queuedEdit) {
			void saveQueuedEdit();
			return;
		}
		if (!busy) {
			submitIntent("prompt");
			return;
		}
		// While running, a plain send follows the follow-up-behavior preference; shortcut modifier+Enter
		// does the opposite unless that combination is itself the send shortcut.
		const inverted = withCmd && sendShortcut !== "cmd-enter-always";
		submitIntent(inverted ? (busyMode === "steer" ? "followUp" : "steer") : busyMode);
	};

	return { saveQueuedEdit, submitIntent, abortSession, submitFromKeyboard };
}
