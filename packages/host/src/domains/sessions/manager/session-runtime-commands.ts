import type { ExtensionUiEditorTextRequest } from "@ling/contracts/session-extension-ui";
import type { ExtensionUiBridge } from "@ling/core/pi-protocol/extension-ui";
import type { SessionRegistry } from "./session-registry";
import type { SessionTranscriptProjectionCache } from "../transcript-projection-cache-port";
import type { MessageFileReference } from "@ling/contracts/file-reference-text";
import {
	type ApplyExtensionAutocompleteRequest,
	type ApplyExtensionAutocompleteResult,
	type ExtensionAutocompleteRequest,
	type ExtensionAutocompleteSuggestions,
	type ExtensionTerminalInputResult,
	type ImageAttachment,
	type ModelState,
	type ReadSessionCompanionRequest,
	type ReadToolResultRequest,
	type ToolResultSessionMessage,
	type ReadTranscriptPageRequest,
	type ReadTranscriptPageResponse,
	type RuntimeCommandCatalogSnapshot,
	type RuntimeExtensionUiSnapshot,
	type SendMode,
	type SessionCommandArgumentCompletionRequest,
	type SessionImageSource,
	type SessionMessage,
	type SessionRef,
	type SessionRuntimeBindingRequest,
	type SessionSnapshot,
	type SessionSnapshotRequest,
	type SetSessionModelRequest,
	type SetSessionThinkingLevelRequest,
	SESSION_MESSAGE_TEXT_MAX_CHARS,
} from "@ling/contracts/session";
import { stripFileReferenceTargets } from "@ling/contracts/file-reference-text";
import { createLingError, throwIfOperationAborted } from "@ling/core/ling-error";
import { createCommandCatalogSnapshot, createExtensionUiSnapshot } from "./session-companion";
import { assertBoundedSessionText } from "./session-input";
import type { ManagedSession } from "./session-managed-state";
import type { SessionQueueController } from "./session-queue";
import type { SessionRuntimePort } from "@ling/core/pi-protocol/runtime-port";
import type { SessionRuntimeQueueKind, SessionRuntimeStateSnapshot } from "@ling/core/pi-protocol/runtime-types";

function invalidSendMode(): never {
	throw createLingError({
		code: "INVALID_REQUEST",
		category: "validation",
		message: "Unknown message send mode.",
		retryable: false,
	});
}

function assertRuntimeRequestBinding(
	interaction: ManagedSession,
	request: SessionRuntimeBindingRequest,
): ReturnType<ManagedSession["eventStream"]["watermark"]> {
	const watermark = interaction.eventStream.watermark();
	if (request.runtimeId !== watermark.runtimeId || request.generation !== watermark.generation) {
		throw createLingError({
			code: "STALE_RUNTIME_GENERATION",
			category: "lifecycle",
			message: "The request targets an inactive runtime generation.",
			retryable: true,
			userAction: "retry",
		});
	}
	return watermark;
}

function assertCompanionRevision(
	projection: string,
	expectedRevision: number | undefined,
	actualRevision: number,
): void {
	if (expectedRevision === undefined || expectedRevision === actualRevision) return;
	throw createLingError({
		code: "STALE_STATE_REVISION",
		category: "lifecycle",
		message: `The ${projection} revision changed before it could be read.`,
		retryable: true,
		userAction: "retry",
		details: { projection, expectedRevision, actualRevision },
	});
}

function isStaleRuntimeGeneration(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === "STALE_RUNTIME_GENERATION"
	);
}

function projectSessionSnapshot(
	interaction: ManagedSession,
	snapshot: SessionRuntimeStateSnapshot,
	transcriptTail: SessionSnapshot["transcriptTail"],
	transcriptCacheKey: string | null,
): SessionSnapshot {
	const watermark = interaction.eventStream.watermark();
	return {
		...watermark,
		ref: { ...interaction.ref },
		lifecycle: "active",
		transcriptTail,
		transcriptCacheKey,
		commandCatalogRevision: interaction.commandCatalogRevision,
		extensionUiRevision: interaction.extensionUiRevision,
		busy: snapshot.busy,
		toolExecutions: interaction.toolExecutions,
		summarizationRetry: interaction.summarizationRetry,
		autoRetry: interaction.autoRetry,
		diagnostics: snapshot.diagnostics,
		queue: interaction.queue.project(snapshot.queue),
	};
}

function currentTranscriptCacheKey(interaction: ManagedSession): string | null {
	const runtimeKey = interaction.session.summarize(0, "").transcriptCacheKey;
	if (runtimeKey === null) return null;
	return `${interaction.resourceReload.appliedRevision()}.${runtimeKey}`;
}

interface ProjectedSnapshotBoundary {
	response: SessionSnapshot;
	cacheKey: string | null;
}

function hasOnlyPersistedMessages(messages: readonly SessionMessage[]): boolean {
	return messages.every((message) => message.entryId !== null);
}

export function createSessionRuntimeCommands({
	registry,
	extensionUi,
	projectionCache,
}: {
	registry: SessionRegistry;
	extensionUi: ExtensionUiBridge;
	projectionCache: SessionTranscriptProjectionCache;
}) {
	const { findManagedSession, hasReplacedSessionRuntime, requireManagedSession } = registry;
	const { getExtensionUiState } = extensionUi;
	const { read: readSessionTranscriptProjection, write: writeSessionTranscriptProjection } = projectionCache;

	/** Runtime-bound renderer requests can arrive after archive/replacement teardown has
	 * retired the managed session. Treat that as the same stale-generation control flow
	 * as a mismatched binding instead of escalating the expected race as SESSION_NOT_FOUND. */
	function requireRuntimeRequestInteraction(request: SessionRuntimeBindingRequest): ManagedSession {
		if (!findManagedSession(request.ref)) {
			throw createLingError({
				code: "STALE_RUNTIME_GENERATION",
				category: "lifecycle",
				message: "The request targets an inactive runtime generation.",
				retryable: true,
				userAction: "retry",
			});
		}
		const interaction = requireManagedSession(request.ref);
		assertRuntimeRequestBinding(interaction, request);
		return interaction;
	}

	function runQueueOperation<T>(
		ref: SessionRef,
		operation: (session: SessionRuntimePort, queue: SessionQueueController) => Promise<T>,
	): Promise<T> {
		const owner = requireManagedSession(ref);
		return owner.queue.run(() => {
			const current = requireManagedSession(ref);
			return operation(current.session, owner.queue);
		});
	}

	/** Viewport/editor mirrors are passive renderer state. Drop only a request whose runtime
	 * was replaced while the IPC was in flight; validation and resource failures still surface. */
	async function updatePassiveExtensionUiMirror(
		ref: SessionRef,
		update: (session: SessionRuntimePort) => Promise<void>,
	): Promise<void> {
		if (hasReplacedSessionRuntime(ref)) return;
		try {
			await update(requireManagedSession(ref).session);
		} catch (error) {
			if (hasReplacedSessionRuntime(ref) || isStaleRuntimeGeneration(error)) return;
			throw error;
		}
	}

	async function sendMessage(
		ref: SessionRef,
		text: string,
		mode: SendMode,
		images?: ImageAttachment[],
		fileReferences?: MessageFileReference[],
	): Promise<void> {
		assertBoundedSessionText(text, SESSION_MESSAGE_TEXT_MAX_CHARS, "Message text");
		if (mode !== "prompt" && mode !== "steer" && mode !== "followUp") invalidSendMode();
		if (fileReferences !== undefined) stripFileReferenceTargets(text, fileReferences);
		const interaction = requireManagedSession(ref);
		// prompt / steer / followUp all append to the same JSONL — block every mode when
		// the CLI advanced the file, not only a fresh prompt turn.
		if (await interaction.fileSync.hasExternalDivergence()) {
			interaction.fileSync.scheduleExternalCheck();
			throw createLingError({
				code: "SESSION_FILE_DIVERGED",
				category: "lifecycle",
				message:
					"The session file was changed outside Ling. The transcript is being refreshed — review it and send again.",
				retryable: true,
				userAction: "retry",
			});
		}
		const prepared = images && images.length > 0 ? await interaction.session.prepareImagesForSend(images) : undefined;
		if (mode === "steer") {
			await runQueueOperation(ref, (session) => session.steer(text, prepared, fileReferences));
		} else if (mode === "followUp") {
			await runQueueOperation(ref, (session) => session.followUp(text, prepared, fileReferences));
		} else {
			// sendPrompt takes no fileReferences: a fresh turn already carries them as @path text
			// (the composer projects chips into the message at the send boundary). Only the queued
			// modes keep the structural list, so their edits stay reversible.
			await interaction.session.sendPrompt(text, prepared);
		}
		void interaction.fileSync.acceptCurrentState();
	}

	function readSessionCommandCatalog(request: ReadSessionCompanionRequest): RuntimeCommandCatalogSnapshot {
		const interaction = requireRuntimeRequestInteraction(request);
		const watermark = interaction.eventStream.watermark();
		assertCompanionRevision("commandCatalog", request.expectedRevision, interaction.commandCatalogRevision);
		return createCommandCatalogSnapshot(
			{ runtimeId: watermark.runtimeId, generation: watermark.generation, ref: interaction.ref },
			interaction.commandCatalogRevision,
			interaction.commandCatalog,
		);
	}

	function readSessionExtensionUiState(request: ReadSessionCompanionRequest): RuntimeExtensionUiSnapshot {
		const interaction = requireRuntimeRequestInteraction(request);
		const watermark = interaction.eventStream.watermark();
		assertCompanionRevision("extensionUi", request.expectedRevision, interaction.extensionUiRevision);
		return createExtensionUiSnapshot(
			{ runtimeId: watermark.runtimeId, generation: watermark.generation, ref: interaction.ref },
			interaction.extensionUiRevision,
			getExtensionUiState(interaction.ref),
		);
	}

	function listCommandArgumentCompletions(
		request: SessionCommandArgumentCompletionRequest,
		signal?: AbortSignal,
	): Promise<ExtensionAutocompleteSuggestions | null> {
		const interaction = requireRuntimeRequestInteraction(request);
		return interaction.session.getCommandArgumentCompletions(request.commandName, request.argumentPrefix, signal);
	}

	function sendExtensionUiInput(ref: SessionRef, data: string): Promise<ExtensionTerminalInputResult> {
		return requireManagedSession(ref).session.sendExtensionUiInput(data);
	}

	function dispatchExtensionTerminalInput(ref: SessionRef, data: string): Promise<ExtensionTerminalInputResult> {
		return requireManagedSession(ref).session.dispatchExtensionTerminalInput(data);
	}

	function updateExtensionUiViewport(
		ref: SessionRef,
		columns: number,
		rows: number,
		markdownColumns: number,
		dockColumns: number,
	): Promise<void> {
		return updatePassiveExtensionUiMirror(ref, (session) =>
			session.updateExtensionUiViewport(columns, rows, markdownColumns, dockColumns),
		);
	}

	function setExtensionUiEditorText(request: ExtensionUiEditorTextRequest): Promise<void> {
		const interaction = requireRuntimeRequestInteraction(request);
		return interaction.session.setExtensionUiEditorText(request.text);
	}

	function getExtensionAutocompleteSuggestions(
		request: ExtensionAutocompleteRequest,
		signal?: AbortSignal,
	): Promise<ExtensionAutocompleteSuggestions | null> {
		const interaction = requireRuntimeRequestInteraction(request);
		return interaction.session.getExtensionAutocompleteSuggestions(
			request.text,
			request.cursorOffset,
			request.force ?? false,
			signal,
		);
	}

	function applyExtensionAutocomplete(
		request: ApplyExtensionAutocompleteRequest,
	): Promise<ApplyExtensionAutocompleteResult> {
		const interaction = requireRuntimeRequestInteraction(request);
		return interaction.session.applyExtensionAutocomplete(
			request.text,
			request.cursorOffset,
			request.item,
			request.prefix,
		);
	}

	/** Edit content or remove (null text) from one queued message. */
	async function editQueuedMessage(
		ref: SessionRef,
		kind: SessionRuntimeQueueKind,
		index: number,
		expectedRevision: number,
		expectedText: string,
		text: string | null,
		images?: ImageAttachment[],
		fileReferences?: MessageFileReference[],
	): Promise<void> {
		assertBoundedSessionText(expectedText, SESSION_MESSAGE_TEXT_MAX_CHARS, "Expected queued message text");
		if (text !== null) {
			assertBoundedSessionText(text, SESSION_MESSAGE_TEXT_MAX_CHARS, "Queued message text");
			if (fileReferences !== undefined) stripFileReferenceTargets(text, fileReferences);
		}
		await runQueueOperation(ref, async (session, queue) => {
			queue.assertRevision(expectedRevision);
			const prepared = images && images.length > 0 ? await session.prepareImagesForSend(images) : images;
			queue.assertRevision(expectedRevision);
			await session.editQueuedMessage(kind, index, expectedText, text, prepared, fileReferences);
		});
	}

	/** Promote a queued follow-up to a steering message delivered into the current run. */
	async function promoteQueuedMessage(
		ref: SessionRef,
		index: number,
		expectedRevision: number,
		expectedText: string,
	): Promise<void> {
		assertBoundedSessionText(expectedText, SESSION_MESSAGE_TEXT_MAX_CHARS, "Expected queued message text");
		await runQueueOperation(ref, (session, queue) => {
			queue.assertRevision(expectedRevision);
			return session.promoteQueuedMessage(index, expectedText);
		});
	}

	async function abortSession(ref: SessionRef): Promise<{ restoredTexts: string[] }> {
		const interaction = requireManagedSession(ref);
		const result = await interaction.session.abort();
		void interaction.fileSync.acceptCurrentState();
		return result;
	}

	async function getModelState(request: SessionRuntimeBindingRequest): Promise<ModelState> {
		const interaction = requireRuntimeRequestInteraction(request);
		return interaction.session.getModelState();
	}

	/** Both writes append to the session file, so the accepted baseline has to move with them.
	 * Without that the file watcher reads Ling's own append as an outside edit and refreshes the
	 * whole session from disk: the runtime rolls over, every projection bound to it is dropped and
	 * refetched, and the transcript, model controls and extension dock all blink. */
	async function setSessionModel(request: SetSessionModelRequest): Promise<ModelState> {
		const interaction = requireRuntimeRequestInteraction(request);
		const state = await interaction.session.setModel(request.provider, request.modelId);
		void interaction.fileSync.acceptCurrentState();
		return state;
	}

	async function setSessionThinkingLevel(request: SetSessionThinkingLevelRequest): Promise<ModelState> {
		const interaction = requireRuntimeRequestInteraction(request);
		const state = await interaction.session.setThinkingLevel(request.level);
		void interaction.fileSync.acceptCurrentState();
		return state;
	}

	/** Summarize and discard older history to free context-window capacity. */
	async function compactSession(ref: SessionRef, customInstructions?: string): Promise<void> {
		if (customInstructions !== undefined) {
			assertBoundedSessionText(customInstructions, SESSION_MESSAGE_TEXT_MAX_CHARS, "Compaction instructions");
		}
		const interaction = requireManagedSession(ref);
		if (await interaction.fileSync.hasExternalDivergence()) {
			interaction.fileSync.scheduleExternalCheck();
			throw createLingError({
				code: "SESSION_FILE_DIVERGED",
				category: "lifecycle",
				message:
					"The session file was changed outside Ling. The transcript is being refreshed — review it and compact again.",
				retryable: true,
				userAction: "retry",
			});
		}
		try {
			await interaction.session.compact(customInstructions);
			void interaction.fileSync.acceptCurrentState();
		} finally {
			interaction.resourceReload.triggerAfterCurrent();
		}
	}

	/** Drops the branch that starts at `entryId` from the active path. The leaf switch is in-memory
	 * only — the next send appends a sibling branch, so nothing is rewritten or lost on disk. */
	async function rewindSession(ref: SessionRef, entryId: string): Promise<void> {
		await requireManagedSession(ref).session.rewindToEntry(entryId);
	}

	async function retryTurn(ref: SessionRef, entryId: string): Promise<void> {
		const interaction = requireManagedSession(ref);
		if (await interaction.fileSync.hasExternalDivergence()) {
			interaction.fileSync.scheduleExternalCheck();
			throw createLingError({
				code: "SESSION_FILE_DIVERGED",
				category: "lifecycle",
				message: "The session changed outside Ling. Refresh the conversation before retrying.",
				retryable: true,
				userAction: "retry",
			});
		}
		try {
			await interaction.session.retryTurn(entryId);
		} finally {
			void interaction.fileSync.acceptCurrentState();
			interaction.resourceReload.triggerAfterCurrent();
		}
	}

	/** Anchor for forking a whole session: the entry its active branch ends on. */
	async function getBranchLeafEntry(ref: SessionRef): Promise<string | null> {
		return await requireManagedSession(ref).session.getBranchLeafEntryId();
	}

	/**
	 * Reads one attachment out of a live session for the authenticated `/api/media/attachment` route. Answers
	 * null for a session that is not bound rather than throwing: a transcript can outlive its runtime,
	 * and an unreachable picture is a placeholder, not a failure.
	 */
	async function readSessionImage(ref: SessionRef, source: SessionImageSource): Promise<ImageAttachment | null> {
		const managed = findManagedSession(ref);
		if (!managed) return null;
		return await managed.session.readImagePart(source.entryId, source.index);
	}

	function assertSnapshotOwner(ref: SessionRef, interaction: ManagedSession): void {
		if (findManagedSession(ref) !== interaction) {
			throw createLingError({
				code: "STALE_RUNTIME_GENERATION",
				category: "lifecycle",
				message: "The session runtime changed while its snapshot was being read.",
				retryable: true,
				userAction: "retry",
			});
		}
	}

	async function readCachedSessionSnapshot(
		ref: SessionRef,
		interaction: ManagedSession,
		cacheKey: string,
	): Promise<SessionSnapshot | null> {
		const messages = await readSessionTranscriptProjection(ref, cacheKey);
		if (messages === null) return null;
		const { boundary } = await interaction.session.getStateSnapshotAtBoundary<SessionSnapshot | null>((snapshot) => {
			assertSnapshotOwner(ref, interaction);
			// Live messages are authoritative only while the runtime owns them. Persisted projection
			// caches are therefore eligible only at an idle event-delivery boundary.
			if (snapshot.busy || currentTranscriptCacheKey(interaction) !== cacheKey) return null;
			const watermark = interaction.eventStream.watermark();
			const transcriptTail = interaction.transcriptPager.createTail(
				{
					runtimeId: watermark.runtimeId,
					generation: watermark.generation,
					ref: interaction.ref,
					transcriptRevision: watermark.transcriptRevision,
				},
				messages,
			);
			return projectSessionSnapshot(interaction, snapshot, transcriptTail, cacheKey);
		});
		return boundary;
	}

	async function getSessionSnapshot(request: SessionSnapshotRequest): Promise<SessionSnapshot> {
		const { ref, transcriptCache } = request;
		const interaction = requireManagedSession(ref);
		if (transcriptCache) {
			const { boundary: cached } = await interaction.session.getStateSnapshotAtBoundary<SessionSnapshot | null>(
				(snapshot) => {
					assertSnapshotOwner(ref, interaction);
					const watermark = interaction.eventStream.watermark();
					const currentCacheKey = currentTranscriptCacheKey(interaction);
					const bindingMatches =
						transcriptCache.runtimeId === watermark.runtimeId &&
						transcriptCache.generation === watermark.generation &&
						transcriptCache.transcriptRevision === watermark.transcriptRevision;
					const persistedBranchMatches = currentCacheKey !== null && transcriptCache.cacheKey === currentCacheKey;
					if (!bindingMatches && !persistedBranchMatches) return null;
					const transcriptTail = interaction.transcriptPager.createEmptyTail({
						runtimeId: watermark.runtimeId,
						generation: watermark.generation,
						ref: interaction.ref,
						transcriptRevision: watermark.transcriptRevision,
					});
					return projectSessionSnapshot(interaction, snapshot, transcriptTail, currentCacheKey);
				},
			);
			if (cached) return cached;
		}

		const requestedCacheKey = currentTranscriptCacheKey(interaction);
		if (requestedCacheKey !== null) {
			const cached = await readCachedSessionSnapshot(ref, interaction, requestedCacheKey);
			if (cached !== null) return cached;
		}

		const { snapshot, boundary } = await interaction.session.getSnapshotAtBoundary<ProjectedSnapshotBoundary>(
			(state) => {
				assertSnapshotOwner(ref, interaction);
				const watermark = interaction.eventStream.watermark();
				const transcriptCacheKey = currentTranscriptCacheKey(interaction);
				const transcriptTail = interaction.transcriptPager.createTail(
					{
						runtimeId: watermark.runtimeId,
						generation: watermark.generation,
						ref: interaction.ref,
						transcriptRevision: watermark.transcriptRevision,
					},
					state.messages,
				);
				return {
					response: projectSessionSnapshot(interaction, state, transcriptTail, transcriptCacheKey),
					cacheKey: transcriptCacheKey,
				};
			},
		);
		// An active streaming row has no durable entry id. It cannot be keyed to the session file,
		// so only an idle, fully persisted projection is safe to reuse after restart. Running
		// turns also carry full tool results, which must not enter the historical summary cache.
		if (!snapshot.busy && boundary.cacheKey !== null && hasOnlyPersistedMessages(snapshot.messages)) {
			await writeSessionTranscriptProjection(ref, boundary.cacheKey, snapshot.messages);
		}
		return boundary.response;
	}

	async function readTranscriptPage(
		request: ReadTranscriptPageRequest,
		signal?: AbortSignal,
	): Promise<ReadTranscriptPageResponse> {
		throwIfOperationAborted(signal);
		const interaction = requireRuntimeRequestInteraction(request);
		const watermark = interaction.eventStream.watermark();
		const page = interaction.transcriptPager.readPage(
			{
				runtimeId: watermark.runtimeId,
				generation: watermark.generation,
				ref: interaction.ref,
				transcriptRevision: watermark.transcriptRevision,
			},
			request,
		);
		throwIfOperationAborted(signal);
		return { requestId: request.operation.requestId, page };
	}

	async function readToolResult(request: ReadToolResultRequest): Promise<ToolResultSessionMessage> {
		const interaction = requireRuntimeRequestInteraction(request);
		const assertCurrent = (): void => {
			assertSnapshotOwner(request.ref, interaction);
			const watermark = assertRuntimeRequestBinding(interaction, request);
			if (watermark.transcriptRevision !== request.expectedTranscriptRevision) {
				throw createLingError({
					code: "STALE_TRANSCRIPT_REVISION",
					category: "lifecycle",
					message: "The transcript changed while loading tool details.",
					retryable: true,
					userAction: "retry",
				});
			}
		};
		assertCurrent();
		const result = await interaction.session.readToolResult(request.entryId);
		assertCurrent();
		return result;
	}
	return {
		sendMessage,
		readSessionCommandCatalog,
		readSessionExtensionUiState,
		listCommandArgumentCompletions,
		sendExtensionUiInput,
		dispatchExtensionTerminalInput,
		updateExtensionUiViewport,
		setExtensionUiEditorText,
		getExtensionAutocompleteSuggestions,
		applyExtensionAutocomplete,
		editQueuedMessage,
		promoteQueuedMessage,
		abortSession,
		getModelState,
		setSessionModel,
		setSessionThinkingLevel,
		compactSession,
		rewindSession,
		retryTurn,
		getBranchLeafEntry,
		readSessionImage,
		getSessionSnapshot,
		readTranscriptPage,
		readToolResult,
	};
}

export type SessionRuntimeCommands = ReturnType<typeof createSessionRuntimeCommands>;
