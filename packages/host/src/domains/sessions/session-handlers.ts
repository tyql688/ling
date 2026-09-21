import { sameSessionRef } from "@ling/contracts/session-ref";
import { createLingError } from "@ling/core/ling-error";
import { assertProjectDirectory } from "@ling/host/runtime/project-directory";
import type {
	ArchivedTranscript,
	CancelSessionOperationResponse,
	ModelState,
	ReadTranscriptPageResponse,
	ResumeSessionResponse,
	SessionCatalogStatus,
	SessionCatalogChange,
	SessionDeletionOutcome,
	SessionRef,
	SessionSnapshot,
	SessionSummary,
} from "@ling/contracts/session";
import { sessionProcedures } from "@ling/contracts/session-procedures";
import { createLogger } from "@ling/core/logger";
import {
	type MetadataCleanupHost,
	metadataCleanupWarning,
	sessionDeletedCleanupFact,
} from "@ling/host/domains/projects/metadata-cleanup";
import type { HostClientState } from "@ling/host/transport/client-state";
import type { HostEventPublisher } from "@ling/host/transport/event-bus";
import type { HostDomain, HostHandlers } from "../../transport/host-domain";
import { applyCatalogMetadata } from "./session-catalog";
import { createSessionCompanionHandlers } from "./session-companion-handlers";
import { createSessionDialogHandlers } from "./session-dialog-handlers";

import type { PiWorkerClient } from "@ling/host/workers/pi/pi-worker-client";
import type { SessionHost } from "./session-host";

const log = createLogger("session-ipc");

export function createSessionDomain({
	clients,
	events,
	projectsRestored,
	sessions,
	readArchivedSession,
	listOpenProjectPaths,
	metadataCleanup,
}: {
	clients: HostClientState;
	events: HostEventPublisher;
	projectsRestored: Promise<void>;
	sessions: SessionHost;
	readArchivedSession: PiWorkerClient["readArchivedSession"];
	listOpenProjectPaths: () => string[];
	metadataCleanup: MetadataCleanupHost;
}): HostDomain {
	const { createSession, deleteSession, forkSession, listAllSessions, resumeSession } = sessions.manager;
	const { findManagedSession, renameSession } = sessions.manager.registry;
	const {
		abortSession,
		compactSession,
		editQueuedMessage,
		getBranchLeafEntry,
		getModelState,
		getSessionSnapshot,
		promoteQueuedMessage,
		readTranscriptPage,
		readToolResult,
		rewindSession,
		retryTurn,
		sendMessage,
		setSessionModel,
		setSessionThinkingLevel,
	} = sessions.manager.commands;
	const { listSessionsFromCatalogCache } = sessions.listCache;
	const publishCatalogChange = (change: SessionCatalogChange): void => {
		sessions.listCache.invalidate();
		events.broadcast(sessionProcedures.onCatalogChanged.channel, change);
	};
	const { recordComposerHistoryEntry } = sessions.composerHistory;
	const {
		status: getStoredSessionCatalogStatus,
		rebuild: rebuildStoredSessionCatalog,
		reconcile: reconcileStoredSessionCatalog,
		retryPersistence: retryStoredSessionCatalogPersistence,
		updateMetadata: updateStoredSessionCatalogMetadata,
	} = sessions.catalog;

	async function listSessionsWithCatalog(projectPaths: string[]): Promise<SessionSummary[]> {
		const sessions = await listSessionsFromCatalogCache(projectPaths);
		const catalog = await reconcileStoredSessionCatalog(sessions);
		return applyCatalogMetadata(sessions, catalog);
	}

	async function updateCatalogAndList(
		projectPaths: string[],
		ref: SessionRef,
		update: { archived?: boolean; pinned?: boolean },
	): Promise<SessionSummary[]> {
		try {
			const sessions = await listSessionsFromCatalogCache(projectPaths);
			const updated = await updateStoredSessionCatalogMetadata(sessions, ref, update);
			publishCatalogChange({ type: "changed" });
			return applyCatalogMetadata(sessions, updated);
		} catch (error) {
			throw new Error("Ling could not update session metadata", { cause: error });
		}
	}

	const {
		operations: sessionOperations,
		dialogs,
		eventBridge,
		retention,
		reviewOperations: changeReviewDiffOperations,
	} = sessions;
	const { coordinateMetadataCleanup } = metadataCleanup;

	const handlers: HostHandlers = {
		...createSessionCompanionHandlers({
			sessionOperations,
			commands: sessions.manager.commands,
			composerHistory: sessions.composerHistory,
		}),
		...createSessionDialogHandlers({
			dialogs,
			sessionOperations,
			onInteractionSettled: retention.reap,
			commands: sessions.manager.commands,
		}),

		[sessionProcedures.setViewedSession.channel]: async (context, value): Promise<void> => {
			clients.setViewedSession(context.clientId, value);
			retention.reap();
		},

		[sessionProcedures.create.channel]: async (context, request): Promise<SessionSummary> => {
			await projectsRestored;
			const summary = await createSession(request.cwd, request.title, {
				beforeBind: (ref) => dialogs.bind(ref),
				...(request.model ? { model: { provider: request.model.provider, id: request.model.modelId } } : {}),
				...(request.thinkingLevel ? { thinkingLevel: request.thinkingLevel } : {}),
			});
			const ref = { cwd: summary.cwd, sessionId: summary.id };
			clients.claimSession(context.clientId, ref);
			eventBridge.bind(ref);
			retention.retain(ref);
			publishCatalogChange({ type: "changed" });
			return summary;
		},

		[sessionProcedures.list.channel]: async (): Promise<SessionSummary[]> => {
			await projectsRestored;
			try {
				return await listSessionsWithCatalog(listOpenProjectPaths());
			} catch (error) {
				throw new Error("Ling could not list sessions", { cause: error });
			}
		},

		[sessionProcedures.catalogStatus.channel]: async (_event): Promise<SessionCatalogStatus> => {
			await projectsRestored;
			return getStoredSessionCatalogStatus();
		},

		[sessionProcedures.retryCatalogPersistence.channel]: async (_event): Promise<SessionCatalogStatus> => {
			await projectsRestored;
			await sessions.catalog.retryRead();
			try {
				const sessions = await listSessionsFromCatalogCache(listOpenProjectPaths());
				await retryStoredSessionCatalogPersistence(sessions);
			} catch (error) {
				log.error("session catalog persistence retry failed:", error);
			}
			return getStoredSessionCatalogStatus();
		},

		[sessionProcedures.rebuildCatalog.channel]: async (_event): Promise<void> => {
			await projectsRestored;
			try {
				const sessions = await listAllSessions(listOpenProjectPaths());
				await rebuildStoredSessionCatalog(sessions);
			} catch (error) {
				throw new Error("Ling could not rebuild the session catalog", { cause: error });
			}
		},

		[sessionProcedures.resume.channel]: async (context, request): Promise<ResumeSessionResponse> => {
			await projectsRestored;
			// Pi cannot bind a runtime whose working directory is gone. Refusing here keeps a
			// session worker from being started only to fail, and names the outcome the renderer
			// branches on to read the archived transcript instead.
			assertProjectDirectory(request.ref.cwd);
			const retentionRevision = retention.retain(request.ref);
			try {
				await resumeSession(request.ref, { beforeBind: (ref) => dialogs.bind(ref) });
				clients.claimSession(context.clientId, request.ref);
				eventBridge.bind(request.ref);
				// retain() runs before asynchronous construction so archive suspension is
				// cancelled promptly. Reap again after attach so concurrent resumes that all
				// crossed the earlier sweep still converge to the bounded warm runtime set.
				retention.reap();
				return { retentionRevision };
			} catch (error) {
				retention.forget([request.ref]);
				throw error;
			}
		},

		[sessionProcedures.delete.channel]: async (_event, ref): Promise<SessionDeletionOutcome> => {
			retention.forget([ref]);
			sessionOperations.cancelByRef(ref, "sessionDeleting");
			changeReviewDiffOperations.cancelByRef(ref, "sessionDeleting");
			await sessions.unsubscribeSessionEvents([ref]);
			await deleteSession(ref);
			const cleanup = await coordinateMetadataCleanup(sessionDeletedCleanupFact(ref));
			publishCatalogChange({ type: "removed", ref });
			const warning = metadataCleanupWarning(cleanup);
			if (warning === null) return { status: "deleted" };
			log.error(warning);
			return { status: "deleted-with-warning", warning };
		},

		[sessionProcedures.sendMessage.channel]: async (context, request): Promise<void> => {
			clients.claimSession(context.clientId, request.ref);
			await sendMessage(request.ref, request.text, request.mode, request.images, request.fileReferences);
			void recordComposerHistoryEntry(request.ref.cwd, request.text).catch((error: unknown) => {
				log.error("composer history record failed:", error);
			});
		},

		[sessionProcedures.editQueued.channel]: async (_event, request): Promise<void> => {
			await editQueuedMessage(
				request.ref,
				request.kind,
				request.index,
				request.expectedRevision,
				request.expectedText,
				request.text,
				request.images,
				request.fileReferences,
			);
		},

		[sessionProcedures.promoteQueued.channel]: async (_event, request): Promise<void> => {
			await promoteQueuedMessage(request.ref, request.index, request.expectedRevision, request.expectedText);
		},

		[sessionProcedures.abort.channel]: async (_event, ref): Promise<{ restoredTexts: string[] }> => {
			return abortSession(ref);
		},

		[sessionProcedures.getSnapshot.channel]: async (_event, request): Promise<SessionSnapshot> =>
			getSessionSnapshot(request),

		[sessionProcedures.readToolResult.channel]: async (_event, request) => readToolResult(request),

		[sessionProcedures.readArchivedTranscript.channel]: async (_event, request): Promise<ArchivedTranscript> => {
			const catalog = await sessions.catalog.snapshot();
			const entry = catalog.find((candidate) => sameSessionRef(candidate.ref, request.ref));
			if (!entry) {
				throw createLingError({
					code: "SESSION_NOT_FOUND",
					category: "validation",
					message: "This session is not in the catalog, so its archived transcript cannot be read.",
					retryable: false,
				});
			}
			return { messages: await readArchivedSession(request.ref.cwd, entry.sessionFilePath, request.markdownWidth) };
		},

		[sessionProcedures.readTranscriptPage.channel]: async (_event, request): Promise<ReadTranscriptPageResponse> => {
			const operation = sessionOperations.start(request);
			return operation.run((signal) => readTranscriptPage(request, signal));
		},

		[sessionProcedures.cancelRequest.channel]: async (_event, request): Promise<CancelSessionOperationResponse> =>
			sessionOperations.cancel(request),

		[sessionProcedures.getModelState.channel]: async (_event, request): Promise<ModelState> => {
			return getModelState(request);
		},

		[sessionProcedures.setModel.channel]: async (_event, request): Promise<ModelState> => {
			return setSessionModel(request);
		},

		[sessionProcedures.setThinkingLevel.channel]: async (_event, request): Promise<ModelState> => {
			return setSessionThinkingLevel(request);
		},

		[sessionProcedures.getBranchLeaf.channel]: async (_event, ref): Promise<string | null> => {
			return getBranchLeafEntry(ref);
		},

		[sessionProcedures.setArchived.channel]: async (_event, request): Promise<SessionSummary[]> => {
			const sessions = await updateCatalogAndList(listOpenProjectPaths(), request.ref, { archived: request.archived });
			if (request.archived) {
				retention.suspendWhenIdle(request.ref);
			} else if (findManagedSession(request.ref)) {
				retention.retain(request.ref);
			}
			return sessions;
		},

		[sessionProcedures.setPinned.channel]: async (_event, request): Promise<SessionSummary[]> => {
			return updateCatalogAndList(listOpenProjectPaths(), request.ref, { pinned: request.pinned });
		},

		[sessionProcedures.fork.channel]: async (context, request): Promise<SessionSummary> => {
			await projectsRestored;
			const summary = await forkSession(request.ref, request.entryId, {
				beforeBind: (ref) => dialogs.bind(ref),
			});
			const ref = { cwd: summary.cwd, sessionId: summary.id };
			clients.claimSession(context.clientId, ref);
			eventBridge.bind(ref);
			retention.retain(ref);
			publishCatalogChange({ type: "changed" });
			return summary;
		},

		[sessionProcedures.retryTurn.channel]: async (_event, request): Promise<void> => {
			await retryTurn(request.ref, request.entryId);
		},
		[sessionProcedures.rewindTo.channel]: async (_event, request): Promise<void> => {
			await rewindSession(request.ref, request.entryId);
		},

		[sessionProcedures.rename.channel]: async (_event, request): Promise<void> => {
			await renameSession(request.ref, request.title);
		},

		[sessionProcedures.compact.channel]: async (_event, request): Promise<void> => {
			await compactSession(request.ref, request.customInstructions);
		},
	};
	return { handlers };
}
