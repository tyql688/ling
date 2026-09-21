import { appPageAtom, newConversationCwdAtom, composerFocusRequestIdAtom } from "@renderer/lib/navigation-state";
import { sessionsAtom, activeSessionRefAtom } from "@renderer/features/sessions/state/session";
import { sameSessionRef } from "@ling/contracts/session-ref";
import { useDomainApi } from "@renderer/lib/host-api-context";
import type { SessionQueuedMessage } from "@ling/contracts/session";
import type { ImageAttachment } from "@ling/contracts/session-messages";
import { projectFileReferenceTargets, type MessageFileReference } from "@ling/contracts/file-reference-text";
import { sessionKey, toSessionRef, type SessionRef } from "@ling/contracts/session-ref";
import type { PendingAttachment } from "@renderer/features/chat/composer/use-image-attachments";
import {
	onRendererSessionStateEvicted,
	setRendererSessionError,
} from "@renderer/features/sessions/runtime/renderer-session-state";
import { fileReferenceTarget } from "@renderer/features/sessions/state/composer-file-references";
import { draftsAtom, EMPTY_DRAFT, type SessionDraft } from "@renderer/features/sessions/state/drafts";
import type { SessionController } from "@renderer/features/sessions/use-sessions";
import type { QuickStartOptions } from "@renderer/features/workspace/use-quick-start-composer";
import { restoreFailedQuickStartDraft } from "@renderer/features/workspace/quick-start-failure";
import { formatRequestError } from "@renderer/lib/errors";
import { atom, useAtom, useSetAtom, useStore } from "jotai";
import { useCallback, useEffect, useMemo } from "react";

export interface QueuedEditState {
	ref: SessionRef;
	sessionKey: string;
	kind: "steering" | "followUp";
	index: number;
	expectedRevision: number;
	expectedText: string;
	/** Invalidates file/image drops still resolving after this edit closes. */
	attachmentScopeKey: string;
	restoreDraft: SessionDraft;
}

const queuedEditAtom = atom<QueuedEditState | null>(null);

export function useWorkspaceSessionActions(options: {
	sessionController: SessionController;
	activeSessionRef: SessionRef | null;
	showCommandError: (error: unknown) => void;
	deselectSession: () => void;
}) {
	const hostSessionApi = useDomainApi("session");

	const { sessionController, activeSessionRef, showCommandError, deselectSession } = options;
	const { createSession, forkSession } = sessionController;
	// Write-and-snapshot access only: subscribing here would re-render WorkspaceShell on
	// every composer keystroke, while nothing in the shell reads the drafts value.
	const setDrafts = useSetAtom(draftsAtom);
	const store = useStore();
	const [newConversationCwd, setNewConversationCwd] = useAtom(newConversationCwdAtom);
	const [queuedEdit, setQueuedEdit] = useAtom(queuedEditAtom);
	useEffect(
		() =>
			onRendererSessionStateEvicted((keys) => {
				setQueuedEdit((current) => (current && keys.includes(current.sessionKey) ? null : current));
			}),
		[setQueuedEdit],
	);
	const [composerFocusRequestId, setComposerFocusRequestId] = useAtom(composerFocusRequestIdAtom);
	const isRetainedSession = useCallback(
		(ref: SessionRef) => store.get(sessionsAtom).some((summary) => sameSessionRef(toSessionRef(summary), ref)),
		[store],
	);
	const reportSessionError = useCallback(
		(ref: SessionRef, cause: unknown) => {
			if (isRetainedSession(ref)) setRendererSessionError(store, sessionKey(ref), formatRequestError(cause));
		},
		[isRetainedSession, store],
	);

	useEffect(
		() => () => {
			const edit = store.get(queuedEditAtom);
			if (!edit) return;
			setDrafts((current) =>
				Object.hasOwn(current, edit.sessionKey) ? { ...current, [edit.sessionKey]: edit.restoreDraft } : current,
			);
			setQueuedEdit(null);
		},
		[setDrafts, setQueuedEdit, store],
	);

	useEffect(() => {
		if (!queuedEdit || (activeSessionRef && sessionKey(activeSessionRef) === queuedEdit.sessionKey)) return;
		setDrafts((current) =>
			Object.hasOwn(current, queuedEdit.sessionKey)
				? { ...current, [queuedEdit.sessionKey]: queuedEdit.restoreDraft }
				: current,
		);
		setQueuedEdit(null);
	}, [activeSessionRef, queuedEdit, setDrafts, setQueuedEdit]);

	const handleFork = useCallback(
		async (entryId: string) => {
			if (!activeSessionRef) return;
			await forkSession(activeSessionRef, entryId);
		},
		[activeSessionRef, forkSession],
	);

	/** Copies the whole active branch, last assistant reply included. */
	const handleForkWhole = useCallback(
		async (ref: SessionRef) => {
			// Sidebar actions can target a persisted session whose runtime is still asleep.
			await hostSessionApi.resume({ ref });
			const leafEntryId = await hostSessionApi.getBranchLeaf(ref);
			if (!leafEntryId) return;
			await forkSession(ref, leafEntryId);
		},
		[hostSessionApi, forkSession],
	);

	/** Editing a message replaces its turn in place: the session rewinds to just before that
	 * entry and resends, so the conversation continues here instead of in a new session. The
	 * replaced turns stay in the session file as an abandoned branch. */
	const handleEditMessage = useCallback(
		async (entryId: string, newText: string) => {
			const ref = activeSessionRef;
			if (!ref) return;
			await hostSessionApi.rewindTo({ ref, entryId });
			try {
				await hostSessionApi.sendMessage({ ref, text: newText, mode: "prompt" });
			} catch (cause) {
				if (!isRetainedSession(ref)) return;
				// The session is already rewound and the edit bubble is gone, so the edited text
				// would otherwise be lost: hand it back to the composer (unless a newer draft exists).
				setDrafts((current) =>
					restoreFailedQuickStartDraft(current, sessionKey(ref), { ...EMPTY_DRAFT, text: newText }),
				);
				if (sameSessionRef(store.get(activeSessionRefAtom), ref)) setComposerFocusRequestId((id) => id + 1);
				reportSessionError(ref, cause);
			}
		},
		[
			activeSessionRef,
			hostSessionApi,
			isRetainedSession,
			setDrafts,
			store,
			setComposerFocusRequestId,
			reportSessionError,
		],
	);

	const handleRenameSession = useCallback(
		async (ref: SessionRef, title: string) => {
			await hostSessionApi.resume({ ref });
			await hostSessionApi.rename({ ref, title });
		},
		[hostSessionApi],
	);

	const handleNewConversation = useCallback(
		(cwd?: string) => {
			store.set(appPageAtom, null);
			setNewConversationCwd(cwd ?? null);
			deselectSession();
			setComposerFocusRequestId((id) => id + 1);
		},
		[deselectSession, setNewConversationCwd, setComposerFocusRequestId, store],
	);

	const handleHomeStart = useCallback(
		async (text: string, start: QuickStartOptions) => {
			const summary = await createSession(start.cwd, {
				...(start.model ? { model: { provider: start.model.provider, modelId: start.model.id } } : {}),
				...(start.thinkingLevel ? { thinkingLevel: start.thinkingLevel } : {}),
			});
			setNewConversationCwd(null);
			const ref = toSessionRef(summary);
			try {
				await hostSessionApi.sendMessage({
					ref,
					text,
					mode: "prompt",
					...(start.images ? { images: start.images } : {}),
					fileReferences: start.fileReferences,
				});
			} catch (cause) {
				if (!isRetainedSession(ref)) return;
				const key = sessionKey(ref);
				setDrafts((current) => restoreFailedQuickStartDraft(current, key, start.draft));
				reportSessionError(ref, cause);
			}
		},
		[createSession, setNewConversationCwd, hostSessionApi, isRetainedSession, setDrafts, reportSessionError],
	);

	const handleCompact = useCallback(async () => {
		if (!activeSessionRef) return;
		try {
			await hostSessionApi.compact({ ref: activeSessionRef });
		} catch (error) {
			showCommandError(error);
		}
	}, [hostSessionApi, activeSessionRef, showCommandError]);

	const startQueuedEdit = useCallback(
		(kind: "steering" | "followUp", index: number, expectedRevision: number, message: SessionQueuedMessage) => {
			if (!activeSessionRef || queuedEdit) return;
			const key = sessionKey(activeSessionRef);
			const attachments: PendingAttachment[] = message.images.map((image) => ({
				id: crypto.randomUUID(),
				dataUrl: `data:${image.mimeType};base64,${image.data}`,
				mimeType: image.mimeType,
			}));
			setQueuedEdit({
				ref: activeSessionRef,
				sessionKey: key,
				kind,
				index,
				expectedRevision,
				expectedText: message.text,
				attachmentScopeKey: crypto.randomUUID(),
				restoreDraft: store.get(draftsAtom)[key] ?? EMPTY_DRAFT,
			});
			const projected = projectFileReferenceTargets(message.text, message.fileReferences);
			const fileReferences = message.fileReferences.map((reference) => ({
				id: crypto.randomUUID(),
				...fileReferenceTarget(reference),
			}));
			setDrafts((current) => ({
				...current,
				[key]: {
					text: projected.text,
					contextPositions: fileReferences.map((reference, index) => ({
						kind: "file",
						id: reference.id,
						offset: projected.offsets[index]!,
					})),
					attachments,
					fileReferences,
					pastedBlocks: [],
					reviewComments: [],
				},
			}));
		},
		[activeSessionRef, queuedEdit, setQueuedEdit, store, setDrafts],
	);

	const cancelQueuedEdit = useCallback(() => {
		if (!queuedEdit) return;
		setDrafts((current) => ({
			...current,
			[queuedEdit.sessionKey]: queuedEdit.restoreDraft,
		}));
		setQueuedEdit(null);
	}, [queuedEdit, setDrafts, setQueuedEdit]);

	const saveQueuedEdit = useCallback(
		async (text: string, images: ImageAttachment[], fileReferences: MessageFileReference[]) => {
			const edit = store.get(queuedEditAtom);
			if (!edit) return;
			const submittedDraft = store.get(draftsAtom)[edit.sessionKey];
			try {
				await hostSessionApi.editQueued({
					ref: edit.ref,
					kind: edit.kind,
					index: edit.index,
					expectedRevision: edit.expectedRevision,
					expectedText: edit.expectedText,
					text,
					images,
					fileReferences,
				});
				if (store.get(queuedEditAtom) !== edit || !isRetainedSession(edit.ref)) return;
				// Preserve text entered while this request was pending; the accepted queue edit owns only its original draft.
				setDrafts((current) =>
					current[edit.sessionKey] === submittedDraft ? { ...current, [edit.sessionKey]: edit.restoreDraft } : current,
				);
				setQueuedEdit((current) => (current === edit ? null : current));
			} catch (error) {
				if (store.get(queuedEditAtom) === edit) showCommandError(error);
			}
		},
		[store, hostSessionApi, isRetainedSession, setDrafts, setQueuedEdit, showCommandError],
	);

	return useMemo(
		() => ({
			setDrafts,
			newConversationCwd,
			setNewConversationCwd,
			queuedEdit,
			composerFocusRequestId,
			setComposerFocusRequestId,
			handleFork,
			handleForkWhole,
			handleEditMessage,
			handleRenameSession,
			handleNewConversation,
			handleHomeStart,
			handleCompact,
			startQueuedEdit,
			cancelQueuedEdit,
			saveQueuedEdit,
		}),
		[
			setDrafts,
			newConversationCwd,
			setNewConversationCwd,
			queuedEdit,
			composerFocusRequestId,
			setComposerFocusRequestId,
			handleFork,
			handleForkWhole,
			handleEditMessage,
			handleRenameSession,
			handleNewConversation,
			handleHomeStart,
			handleCompact,
			startQueuedEdit,
			cancelQueuedEdit,
			saveQueuedEdit,
		],
	);
}
