import { randomUUID } from "node:crypto";
import { record } from "@ling/contracts/records";
import type { LingSessionEvent, RunOutcome, SessionMessage } from "@ling/contracts/session";
import { TOOL_PROGRESS_MAX_CHARS } from "@ling/contracts/session-tool-progress";
import { createLogger } from "../../logger";
import { inspectPiSessionEntryIdentity } from "../../transcript/session-entry-identity";
import { renderPiCustomMessage } from "../extensions/extension-message-renderer";
import { createPiToolRendererProjection } from "../extensions/extension-tool-renderer";
import { hasPiMarkdownTransformers, transformPiMarkdownMessage } from "../extensions/markdown-transformer";
import { type PiAgentSession, type PiAgentSessionEvent, piBranchProjectionSource } from "../types";
import { normalizePiMessage } from "./message-normalizer";
import type { PiQueueMirror } from "./queue-mirror";
import { createAssistantGeneration } from "./assistant-generation";

interface PiSessionEventAdapterOptions {
	session: PiAgentSession;
	onDeferredEvent: (event: LingSessionEvent) => void;
	getMarkdownWidth: () => number;
	queueMirror: () => PiQueueMirror;
}

interface PiSessionEventAdapter {
	adapt(sdkEvent: PiAgentSessionEvent): LingSessionEvent | null;
	dispose(): void;
}

interface LiveMessageSlot {
	id: string;
	role: string;
}

const log = createLogger("pi-session-event-adapter");

/** Correlation state only bridges one live run; caps defend malformed extension roles/events. */
const MAX_PERSISTED_MESSAGE_CORRELATIONS = 128;
const MAX_ENDED_MESSAGE_ROLES = 16;

function messageRole(value: unknown): string {
	const source = record(value);
	return typeof source?.role === "string" ? source.role : "unknown";
}

function lastAssistantFailure(messages: readonly unknown[]): RunOutcome {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = record(messages[index]);
		if (message?.role !== "assistant") continue;
		if (message.stopReason === "error") {
			return {
				status: "failed",
				message: typeof message.errorMessage === "string" ? message.errorMessage : "Agent turn failed",
			};
		}
		if (message.stopReason === "aborted") return { status: "cancelled" };
		return { status: "success" };
	}
	return { status: "success" };
}

function activity(id: string, text: string, tone?: "normal" | "error"): LingSessionEvent {
	return tone ? { type: "activity", id, text, tone } : { type: "activity", id, text };
}

function isPersistedMessageRole(value: unknown): boolean {
	const role = messageRole(value);
	return role === "user" || role === "assistant" || role === "toolResult" || role === "custom";
}

function resolvePersistedMessage(
	session: PiAgentSession,
	rawMessage: unknown,
	previousLeafId: string | null,
	messageId: string,
): SessionMessage | null {
	const entry = session.sessionManager.getLeafEntry();
	if (!entry || entry.parentId !== previousLeafId) return null;

	let persistedValue: unknown;
	if (entry.type === "message") {
		if (entry.message !== rawMessage) return null;
		persistedValue = entry.message;
	} else if (entry.type === "custom_message") {
		const source = record(rawMessage);
		if (
			source?.role !== "custom" ||
			source.customType !== entry.customType ||
			source.content !== entry.content ||
			source.display !== entry.display ||
			source.details !== entry.details
		) {
			return null;
		}
		persistedValue = {
			role: "custom",
			customType: entry.customType,
			content: entry.content,
			display: entry.display,
			...(entry.details === undefined ? {} : { details: entry.details }),
		};
	} else {
		return null;
	}

	const identity = inspectPiSessionEntryIdentity(entry);
	if (identity.status === "invalid") return null;
	const normalized = normalizePiMessage(persistedValue, {
		messageId,
		entryId: identity.identity.entryId,
		occurredAt: identity.identity.occurredAt,
	});
	if (normalized.role !== "custom") return normalized;
	// Same projection as session-message-projector: an extension's registered message
	// renderer must apply live, not only after a reload, or the same message shows its
	// model-facing content during the run and its TUI rendering afterwards.
	const rendered = renderPiCustomMessage(session, normalized);
	return rendered === undefined
		? normalized
		: normalizePiMessage(
				{ ...normalized, rendered },
				{ messageId, entryId: identity.identity.entryId, occurredAt: identity.identity.occurredAt },
			);
}

interface EventAdapterState extends PiSessionEventAdapterOptions {
	finalOutcome: RunOutcome;
	agentRunActive: boolean;
	idleCompactionRunActive: boolean;
	activeCompactionReason: "manual" | "threshold" | "overflow" | null;
	disposed: boolean;
	toolRenderer: ReturnType<typeof createPiToolRendererProjection>;
	allocateMessageId(): string;
	clearRun(): void;
}

const AUXILIARY_EVENT_ADAPTERS = {
	agent_start: adaptAgentEvent,
	agent_end: adaptAgentEvent,
	agent_settled: adaptAgentEvent,
	compaction_start: adaptCompactionEvent,
	compaction_end: adaptCompactionEvent,
	tool_execution_start: adaptToolEvent,
	tool_execution_update: adaptToolEvent,
	tool_execution_end: adaptToolEvent,
	auto_retry_start: adaptRetryEvent,
	auto_retry_end: adaptRetryEvent,
	summarization_retry_scheduled: adaptRetryEvent,
	summarization_retry_attempt_start: adaptRetryEvent,
	summarization_retry_finished: adaptRetryEvent,
} satisfies Partial<{
	[K in PiAgentSessionEvent["type"]]: (
		owner: EventAdapterState,
		event: Extract<PiAgentSessionEvent, { type: K }>,
	) => LingSessionEvent | null;
}>;
export function createPiSessionEventAdapter(options: PiSessionEventAdapterOptions): PiSessionEventAdapter {
	const { session, onDeferredEvent, getMarkdownWidth, queueMirror } = options;
	const defer = queueMicrotask;
	let activeMessage: LiveMessageSlot | null = null;
	const rawMessageIds = new WeakMap<object, string>();
	const generation = createAssistantGeneration(session.sessionManager);
	const lastEndedIdByRole = new Map<string, string>();
	const persistedEntryByMessageId = new Map<string, string>();
	const toolRenderer = createPiToolRendererProjection(piBranchProjectionSource(session));
	const owner: EventAdapterState = {
		...options,
		finalOutcome: { status: "success" },
		agentRunActive: false,
		idleCompactionRunActive: false,
		activeCompactionReason: null,
		disposed: false,
		toolRenderer,
		allocateMessageId,
		clearRun() {
			generation.clear();
			lastEndedIdByRole.clear();
			persistedEntryByMessageId.clear();
			toolRenderer.clear();
		},
	};

	function allocateMessageId(): string {
		// The renderer retains live IDs after persistence, reload and worker replacement.
		return `message:${randomUUID()}`;
	}

	function rememberRawMessage(value: unknown, messageId: string): void {
		if (value !== null && typeof value === "object") rawMessageIds.set(value, messageId);
	}

	function knownRawMessageId(value: unknown): string | undefined {
		return value !== null && typeof value === "object" ? rawMessageIds.get(value) : undefined;
	}

	function startMessage(value: unknown): string {
		const messageId = allocateMessageId();
		activeMessage = { id: messageId, role: messageRole(value) };
		rememberRawMessage(value, messageId);
		return messageId;
	}

	function continueMessage(value: unknown): string {
		const role = messageRole(value);
		const known = knownRawMessageId(value);
		if (known) return known;
		if (activeMessage?.role === role) {
			rememberRawMessage(value, activeMessage.id);
			return activeMessage.id;
		}
		const messageId = allocateMessageId();
		activeMessage = { id: messageId, role };
		rememberRawMessage(value, messageId);
		return messageId;
	}

	function normalizeLiveMessage(
		value: unknown,
		messageId: string,
		occurredAt: number,
		final: boolean,
		isStreaming: boolean,
	): SessionMessage {
		const message = normalizePiMessage(
			toolRenderer.project(
				generation.project(value, persistedEntryByMessageId.get(messageId) ?? null),
				final,
				false,
				persistedEntryByMessageId.get(messageId) ?? null,
			),
			{
				messageId,
				entryId: persistedEntryByMessageId.get(messageId) ?? null,
				occurredAt,
			},
		);
		return transformPiMarkdownMessage(session, message, {
			isStreaming,
			availableWidth: getMarkdownWidth(),
		});
	}

	function rememberEndedMessage(role: string, messageId: string): void {
		lastEndedIdByRole.delete(role);
		lastEndedIdByRole.set(role, messageId);
		while (lastEndedIdByRole.size > MAX_ENDED_MESSAGE_ROLES) {
			const oldest = lastEndedIdByRole.keys().next().value;
			if (oldest === undefined) break;
			lastEndedIdByRole.delete(oldest);
		}
	}

	function rememberPersistedEntry(messageId: string, entryId: string): void {
		persistedEntryByMessageId.delete(messageId);
		persistedEntryByMessageId.set(messageId, entryId);
		while (persistedEntryByMessageId.size > MAX_PERSISTED_MESSAGE_CORRELATIONS) {
			const oldest = persistedEntryByMessageId.keys().next().value;
			if (oldest === undefined) break;
			persistedEntryByMessageId.delete(oldest);
		}
	}

	function schedulePersistencePromotion(rawMessage: unknown, messageId: string, previousLeafId: string | null): void {
		if (!isPersistedMessageRole(rawMessage)) return;
		defer(() => {
			if (owner.disposed) return;
			const message = resolvePersistedMessage(session, rawMessage, previousLeafId, messageId);
			if (!message?.entryId) {
				onDeferredEvent({ type: "snapshotChanged" });
				onDeferredEvent(
					activity(
						`message-persistence-correlation:${messageId}`,
						"Message persistence identity changed; transcript was reloaded",
						"error",
					),
				);
				return;
			}
			rememberPersistedEntry(messageId, message.entryId);
			onDeferredEvent({
				type: "messagePersisted",
				messageId,
				entryId: message.entryId,
			});
		});
	}

	return {
		adapt(event) {
			if (isAuxiliaryEvent(event)) {
				// The discriminant selects the matching narrow handler; the table preserves that relation.
				return AUXILIARY_EVENT_ADAPTERS[event.type](owner, event as never);
			}
			switch (event.type) {
				case "entry_appended":
					return { type: "snapshotChanged" };

				case "turn_start":
					return { type: "runStarted", runId: "turn", timestamp: Date.now() };

				case "turn_end": {
					const occurredAt = Date.now();
					const role = messageRole(event.message);
					const messageId = knownRawMessageId(event.message) ?? lastEndedIdByRole.get(role) ?? allocateMessageId();
					rememberRawMessage(event.message, messageId);
					return {
						type: "turnEnd",
						message: normalizeLiveMessage(event.message, messageId, occurredAt, true, false),
					};
				}

				case "message_start": {
					// System messages persist model instructions/tool changes, not conversation rows.
					if (event.message.role === "system") return null;
					const occurredAt = Date.now();
					const messageId = startMessage(event.message);
					if (messageRole(event.message) === "assistant") generation.start(messageId);
					// A real attempt streaming again ends the hold; the synthetic failure message Pi emits
					// for a request that never streamed (stopReason preset to "error") does not.
					if (messageRole(event.message) === "assistant" && record(event.message)?.stopReason !== "error") {
						void queueMirror()
							.unpark()
							.catch((error: unknown) => log.error("failed to restore the parked session queue:", error));
					}
					return {
						type: "messageStart",
						message: normalizeLiveMessage(event.message, messageId, occurredAt, false, true),
					};
				}

				case "message_update": {
					const occurredAt = Date.now();
					const messageId = continueMessage(event.message);
					generation.update(messageId, event.assistantMessageEvent);
					return {
						type: "messageUpdate",
						message: normalizeLiveMessage(event.message, messageId, occurredAt, false, true),
						...(hasPiMarkdownTransformers(session) ? { streamMode: "full" as const } : {}),
					};
				}

				case "message_end": {
					if (event.message.role === "system") return null;
					const occurredAt = Date.now();
					const messageId = continueMessage(event.message);
					try {
						generation.finish(messageId, event.message);
					} catch (error) {
						// Optional measurement persistence must not prevent Pi from saving the actual answer.
						log.error("Failed to persist generation timing:", error);
						defer(() => {
							if (!owner.disposed)
								onDeferredEvent(
									activity(`generation-timing:${messageId}`, "Generation timing could not be saved", "error"),
								);
						});
					}
					const previousLeafId = session.sessionManager.getLeafId();
					const role = messageRole(event.message);
					rememberRawMessage(event.message, messageId);
					rememberEndedMessage(role, messageId);
					if (activeMessage?.id === messageId) activeMessage = null;
					schedulePersistencePromotion(event.message, messageId, previousLeafId);
					return {
						type: "messageEnd",
						message: normalizeLiveMessage(event.message, messageId, occurredAt, true, false),
					};
				}

				case "bash_execution_update":
					// Ling does not expose Pi's direct/RPC bash command surface. Built-in
					// tool streaming continues through tool_execution_update.
					return null;

				case "queue_update":
					// Pi's queue_update is text-only; PiQueueMirror emits the authoritative queue with
					// draft text, images and file references, so this event carries nothing to add.
					return null;

				case "session_info_changed":
					return { type: "snapshotChanged" };

				case "thinking_level_changed":
					return activity("thinking-level-changed", `Thinking level changed: ${event.level}`);
			}
			throw new Error("Unsupported Pi session event");
		},
		dispose() {
			owner.disposed = true;
			owner.agentRunActive = false;
			owner.idleCompactionRunActive = false;
			owner.activeCompactionReason = null;
			activeMessage = null;
			generation.clear();
			lastEndedIdByRole.clear();
			persistedEntryByMessageId.clear();
			toolRenderer.clear();
		},
	};
}

function adaptAgentEvent(
	owner: EventAdapterState,
	event: Extract<PiAgentSessionEvent, { type: "agent_start" | "agent_end" | "agent_settled" }>,
): LingSessionEvent | null {
	switch (event.type) {
		case "agent_start": {
			if (owner.agentRunActive) return null;
			const timestamp = Date.now();
			owner.agentRunActive = true;
			return { type: "runStarted", runId: "agent", timestamp };
		}

		case "agent_end":
			// Pi can retry, compact, or drain queued continuations after agent_end. Preserve the
			// outcome, but keep Ling busy until agent_settled.
			owner.finalOutcome = lastAssistantFailure(event.messages);
			// A failed attempt must not let Pi drain the queue into the failing provider:
			// park it now (synchronously, before _handlePostAgentRun runs) and hand it back
			// to Pi when an attempt streams again, or to the user when the run ends failed.
			if (owner.finalOutcome.status === "failed") {
				try {
					owner.queueMirror().park();
				} catch (error) {
					log.error("failed to park the owner.session queue after a failed attempt:", error);
				}
			}
			return null;

		case "agent_settled": {
			const timestamp = Date.now();
			let outcome = owner.finalOutcome;
			owner.finalOutcome = { status: "success" };
			const restoredMessages = owner.queueMirror().takeParked();
			if (restoredMessages.length > 0) {
				outcome =
					outcome.status === "failed"
						? { ...outcome, restoredMessages }
						: { status: "failed", message: "Queued messages were not sent", restoredMessages };
			}
			owner.agentRunActive = false;
			owner.clearRun();
			return { type: "runFinished", runId: "agent", outcome, timestamp };
		}
	}
}

function adaptCompactionEvent(
	owner: EventAdapterState,
	event: Extract<PiAgentSessionEvent, { type: "compaction_start" | "compaction_end" }>,
): LingSessionEvent | null {
	switch (event.type) {
		case "compaction_start": {
			owner.activeCompactionReason = event.reason;
			const status: LingSessionEvent = {
				type: "summarizationRetryChanged",
				status: { phase: "running", source: "compaction", reason: event.reason },
			};
			// Compaction outside an agent run (manual /compact, pre-prompt check) is
			// still exclusive work in Pi (prompt() rejects while it runs). Project it
			// as its own "compaction" run: busy consumers treat it like a turn, while
			// agent-turn side effects (notifications, auto-title, change review) stay
			// keyed to runId "agent" and ignore it.
			if (!owner.agentRunActive) {
				owner.idleCompactionRunActive = true;
				const timestamp = Date.now();
				queueMicrotask(() => {
					if (!owner.disposed) owner.onDeferredEvent(status);
				});
				return { type: "runStarted", runId: "compaction", timestamp };
			}
			return status;
		}

		case "compaction_end": {
			const transcriptChanged = event.result !== undefined && !event.aborted && !event.errorMessage;
			owner.activeCompactionReason = null;
			const closesIdleCompactionRun = owner.idleCompactionRunActive;
			owner.idleCompactionRunActive = false;
			const outcome: RunOutcome = event.errorMessage
				? { status: "failed", message: event.errorMessage }
				: event.aborted
					? { status: "cancelled" }
					: { status: "success" };
			const timestamp = Date.now();
			queueMicrotask(() => {
				if (owner.disposed) return;
				owner.onDeferredEvent({ type: "summarizationRetryChanged", status: null });
				if (transcriptChanged) {
					owner.onDeferredEvent({ type: "transcriptInvalidated", reason: "compaction" });
				}
				if (closesIdleCompactionRun) {
					owner.onDeferredEvent({ type: "runFinished", runId: "compaction", outcome, timestamp });
				}
			});
			if (event.result && !event.aborted && !event.errorMessage) {
				return adaptCompactionResult(owner, event.result);
			}
			const tone = event.errorMessage ? "error" : "normal";
			const text = event.errorMessage
				? `Compaction failed: ${event.errorMessage}`
				: event.aborted
					? `Compaction cancelled: ${event.reason}`
					: `Compaction ended: ${event.reason}`;
			return activity(`compaction-end:${event.reason}`, text, tone);
		}
	}
}

function adaptToolEvent(
	owner: EventAdapterState,
	event: Extract<
		PiAgentSessionEvent,
		{ type: "tool_execution_start" | "tool_execution_update" | "tool_execution_end" }
	>,
): LingSessionEvent | null {
	switch (event.type) {
		case "tool_execution_start":
			return {
				type: "toolExecutionChanged",
				toolCallId: event.toolCallId,
				progress: {
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					text: "",
					truncated: false,
				},
			};

		case "tool_execution_update": {
			const source = record(event.partialResult);
			if (!source || !Array.isArray(source.content)) throw new Error("Tool update has no result content.");
			const result = normalizePiMessage(
				{ ...source, role: "toolResult", toolCallId: event.toolCallId, toolName: event.toolName, isError: false },
				{
					messageId: `tool-progress:${event.toolCallId}`,
					entryId: null,
					occurredAt: Date.now(),
				},
			);
			if (result.role !== "toolResult") throw new Error("Tool update did not normalize as a tool result.");
			const text = result.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n");
			const rendered = owner.toolRenderer.projectPartial(event.toolCallId, source);
			return {
				type: "toolExecutionChanged",
				toolCallId: event.toolCallId,
				progress: {
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					text: text.slice(-TOOL_PROGRESS_MAX_CHARS),
					truncated: text.length > TOOL_PROGRESS_MAX_CHARS,
					...(rendered === undefined ? {} : { rendered }),
				},
			};
		}

		case "tool_execution_end":
			return { type: "toolExecutionChanged", toolCallId: event.toolCallId, progress: null };
	}
}

function adaptRetryEvent(
	owner: EventAdapterState,
	event: Extract<
		PiAgentSessionEvent,
		{
			type:
				| "auto_retry_start"
				| "auto_retry_end"
				| "summarization_retry_scheduled"
				| "summarization_retry_attempt_start"
				| "summarization_retry_finished";
		}
	>,
): LingSessionEvent | null {
	switch (event.type) {
		case "auto_retry_start":
			return {
				type: "autoRetryChanged",
				status: {
					attempt: event.attempt,
					maxAttempts: event.maxAttempts,
					delayMs: event.delayMs,
					// Retry error messages are truncated to 2048 chars for the IPC display budget
					errorMessage: event.errorMessage.slice(0, 2_048),
				},
			};

		case "auto_retry_end":
			return { type: "autoRetryChanged", status: null };

		case "summarization_retry_scheduled":
			return {
				type: "summarizationRetryChanged",
				status: {
					phase: "waiting",
					attempt: event.attempt,
					maxAttempts: event.maxAttempts,
					delayMs: event.delayMs,
					// Retry error messages are truncated to 2048 chars for the IPC display budget
					errorMessage: event.errorMessage.slice(0, 2_048),
				},
			};

		case "summarization_retry_attempt_start": {
			return {
				type: "summarizationRetryChanged",
				status:
					event.source === "branchSummary"
						? { phase: "running", source: "branchSummary" }
						: { phase: "running", source: "compaction", reason: event.reason },
			};
		}

		case "summarization_retry_finished":
			return {
				type: "summarizationRetryChanged",
				status:
					owner.activeCompactionReason === null
						? null
						: { phase: "running", source: "compaction", reason: owner.activeCompactionReason },
			};
	}
}

function isAuxiliaryEvent(
	event: PiAgentSessionEvent,
): event is Extract<PiAgentSessionEvent, { type: keyof typeof AUXILIARY_EVENT_ADAPTERS }> {
	return Object.hasOwn(AUXILIARY_EVENT_ADAPTERS, event.type);
}
/** Correlate a successful compaction with its durable entry before publishing it. */
function adaptCompactionResult(
	owner: EventAdapterState,
	result: NonNullable<Extract<PiAgentSessionEvent, { type: "compaction_end" }>["result"]>,
): LingSessionEvent {
	const leaf = owner.session.sessionManager.getLeafEntry();
	const persistedEntry =
		leaf?.type === "compaction" &&
		leaf.summary === result.summary &&
		leaf.firstKeptEntryId === result.firstKeptEntryId &&
		leaf.tokensBefore === result.tokensBefore
			? leaf
			: null;
	const persistedIdentity = persistedEntry ? inspectPiSessionEntryIdentity(persistedEntry) : null;
	if (persistedIdentity?.status === "invalid") {
		return activity(
			"compaction-persistence-correlation",
			"Compaction persistence identity changed; transcript was reloaded",
			"error",
		);
	}
	const occurredAt = persistedIdentity?.identity.occurredAt ?? Date.now();
	const messageId = owner.allocateMessageId();
	const message = normalizePiMessage(
		{
			role: "compactionSummary",
			summary: result.summary,
			tokensBefore: result.tokensBefore,
			...(result.usage ? { usage: result.usage } : {}),
			timestamp: occurredAt,
		},
		{
			messageId: persistedIdentity?.identity.messageId ?? messageId,
			entryId: persistedIdentity?.identity.entryId ?? null,
			occurredAt,
		},
	);
	if (message.role === "compactionSummary") return { type: "compactionSummary", message };
	return activity("compaction-invalid-result", "Compaction returned an invalid result", "error");
}
