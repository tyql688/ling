import type { SummarizationRetryStatus } from "@ling/contracts/session";
import type { SessionMessage } from "@ling/contracts/session-messages";
import { sessionMessageRowIdentity } from "@renderer/features/sessions/runtime/session-message-identity";
import { isResolvedByLaterCompaction } from "./compaction-errors";
import { uniqueToolCalls } from "./tool-calls";

/** Assistant content is a real discriminated union (text/thinking/toolCall) — keep its exact shape
 * so `thinking` narrows to `ThinkingContent`'s actual field name instead of a guessed `text` field. */
export type AssistantContentPart = Extract<SessionMessage, { role: "assistant" }>["content"][number];
type ToolCallPart = Extract<AssistantContentPart, { type: "toolCall" }>;
type ToolResultMsg = Extract<SessionMessage, { role: "toolResult" }>;

export type ToolCategory = "read" | "edit" | "run" | "other";

/**
 * Built-in tool names → activity-row icon categories. Only common Pi tools are listed;
 * unlisted ones fall back to `other`, avoiding hard-coded icons for every unknown extension tool.
 */
const TOOL_CATEGORY_BY_NAME: Record<string, ToolCategory> = {
	read: "read",
	grep: "read",
	find: "read",
	ls: "read",
	edit: "edit",
	write: "edit",
	bash: "run",
};

export function toolCategoryForName(name: string): ToolCategory {
	if (!Object.hasOwn(TOOL_CATEGORY_BY_NAME, name)) return "other";
	return TOOL_CATEGORY_BY_NAME[name] ?? "other";
}

export interface ToolStep {
	call: ToolCallPart;
	result: ToolResultMsg | undefined;
}

export type ActivityFailureItem = {
	type: "failure";
	index: number;
	/** 1-based position in the current failure streak — mirrors Pi's retry counter, which
	 * resets on any successful assistant message: failure 1 is the original request,
	 * failure k > 1 is retry k-1 failing. */
	attempt: number;
	message: Extract<SessionMessage, { role: "assistant" }>;
	resolvedByLaterCompaction: boolean;
};

type ActivityItem =
	| { type: "thinking"; text: string; revisionSources: object[] }
	/** Intermediate assistant prose on toolUse turns — stays inside the work fold, not a plain bubble. */
	| { type: "text"; text: string; revisionSources: object[] }
	| { type: "step"; step: ToolStep }
	/** A displayed extension message delivered mid-turn (e.g. a steered `pi.sendMessage`) — kept at
	 * its chronological place among the tool steps so it scrolls with the stream. */
	| { type: "custom"; message: Extract<SessionMessage, { role: "custom" }> }
	/** A mid-run compaction — stays inside the work fold at its chronological place instead of
	 * splitting the run into two folds around a top-level divider. */
	| { type: "compaction"; summary: string }
	| ActivityFailureItem;

export interface ActivityRow {
	kind: "activity";
	keyId: string;
	items: ActivityItem[];
	startTs: number | undefined;
	endTs: number | undefined;
	running: boolean;
	/** A settled turn's outer disclosure already owns expansion, so this row renders
	 * its contents directly instead of adding a second activity disclosure. */
	expandedByTurnFold: boolean;
}

interface PlainTimelineRow {
	kind: "plain";
	index: number;
	message: SessionMessage;
	/** Current user ordinal for a user row, or the latest preceding user for later rows. */
	userMessageOrdinal: number;
}

export type TimelineRow = PlainTimelineRow | ActivityRow;

const displayRevisionIds = new WeakMap<object, number>();
let nextDisplayRevisionId = 1;

function displayRevisionId(value: object): number {
	const current = displayRevisionIds.get(value);
	if (current !== undefined) return current;
	const next = nextDisplayRevisionId++;
	displayRevisionIds.set(value, next);
	return next;
}

function activityItemRevisions(row: ActivityRow): string[] {
	return row.items.map((item) => {
		if (item.type === "thinking") return `t${item.revisionSources.map(displayRevisionId).join(".")}`;
		if (item.type === "text") return `x${item.revisionSources.map(displayRevisionId).join(".")}`;
		if (item.type === "step") {
			return `s${displayRevisionId(item.step.call)}:${item.step.result ? displayRevisionId(item.step.result) : 0}`;
		}
		if (item.type === "custom") return `c${displayRevisionId(item.message)}`;
		if (item.type === "compaction") return `k${item.summary.length}`;
		return `f${displayRevisionId(item.message)}:${Number(item.resolvedByLaterCompaction)}`;
	});
}

/** Stable semantic revision for memoized row rendering. Rebuilding normalized rows around an
 * unchanged transcript must not rerender every row; visible state changes still invalidate it. */
export function timelineRowDisplayRevision(
	row: TimelineRow,
	options: { toolsExpanded: boolean; hiddenThinkingLabel: string | null; editingUserRowId: string | null },
): string {
	if (row.kind === "activity") {
		return JSON.stringify([
			"activity",
			row.running,
			row.expandedByTurnFold,
			options.toolsExpanded,
			options.hiddenThinkingLabel,
			...activityItemRevisions(row),
		]);
	}

	const { message } = row;
	const identity = sessionMessageRowIdentity(message);
	const base = `${identity}:object:${displayRevisionId(message)}`;
	if (message.role === "custom") return `${base}:tools:${Number(options.toolsExpanded)}`;
	if (message.role === "user") return `${base}:editing:${Number(identity === options.editingUserRowId)}`;
	return base;
}

function upsertToolStep(activity: ActivityRow, call: ToolCallPart, result: ToolResultMsg | undefined) {
	const next: ActivityItem = { type: "step", step: { call, result } };
	for (const [index, item] of activity.items.entries()) {
		if (item.type !== "step" || item.step.call.id !== call.id) continue;
		activity.items[index] = next;
		return;
	}
	activity.items.push(next);
}

export function buildResultIndex(messages: readonly SessionMessage[]): Map<string, ToolResultMsg> {
	const byCallId = new Map<string, ToolResultMsg>();
	for (const message of messages) {
		if (message.role === "toolResult" && message.toolCallId) byCallId.set(message.toolCallId, message);
	}
	return byCallId;
}

/** Seed for continuing {@link buildRows} after a frozen history prefix (live-turn rebuild). */
export interface BuildRowsSeed {
	latestUserOrdinal: number;
	lastUserTs: number | undefined;
}

interface BuildRowsOptions {
	/**
	 * Absolute transcript index of `messages[0]`. Live rebuilds pass the history message
	 * count so plain-row `index` values stay aligned with the full message list.
	 */
	indexOffset?: number;
	/** Prior user/ordinal state when `messages` is only the live tail. */
	seed?: BuildRowsSeed;
}

export function buildRowsSeedFromMessages(messages: readonly SessionMessage[]): BuildRowsSeed {
	let latestUserOrdinal = -1;
	let lastUserTs: number | undefined;
	for (const message of messages) {
		if (message.role !== "user") continue;
		latestUserOrdinal += 1;
		lastUserTs = message.timestamp;
	}
	return { latestUserOrdinal, lastUserTs };
}

export function buildRows(
	messages: readonly SessionMessage[],
	resultByCallId: Map<string, ToolResultMsg>,
	busy: boolean,
	options?: BuildRowsOptions,
): TimelineRow[] {
	const indexOffset = options?.indexOffset ?? 0;
	const callIds = new Set<string>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const part of message.content) {
			if (part.type === "toolCall") callIds.add(part.id);
		}
	}

	const rows: TimelineRow[] = [];
	let activity: ActivityRow | null = null;
	let failureStreak = 0;
	let lastUserTs: number | undefined = options?.seed?.lastUserTs;
	let latestUserOrdinal = options?.seed?.latestUserOrdinal ?? -1;

	/** Opens the current turn's activity row on first use; every writer funnels through here. */
	const ensureActivity = (rowIdentity: string): ActivityRow => {
		if (!activity) {
			activity = {
				kind: "activity",
				keyId: rowIdentity,
				items: [],
				startTs: lastUserTs,
				endTs: undefined,
				running: false,
				expandedByTurnFold: false,
			};
			rows.push(activity);
		}
		return activity;
	};

	messages.forEach((message, localIndex) => {
		const index = indexOffset + localIndex;
		const rowIdentity = sessionMessageRowIdentity(message);
		if (message.role === "user") {
			activity = null;
			failureStreak = 0;
			lastUserTs = message.timestamp;
			latestUserOrdinal += 1;
			rows.push({
				kind: "plain",
				index,
				message,
				userMessageOrdinal: latestUserOrdinal,
			});
			return;
		}
		if (message.role === "toolResult") {
			if (message.toolCallId && callIds.has(message.toolCallId)) {
				if (activity) activity.endTs = message.timestamp ?? activity.endTs;
				return;
			}
			rows.push({
				kind: "plain",
				index,
				message,
				userMessageOrdinal: latestUserOrdinal,
			});
			return;
		}
		if (message.role === "custom" && message.display && activity) {
			// Inside the running work row, not after it: a plain row here would sit below every
			// later tool step (the row keeps growing above it) and look pinned to the composer.
			activity.items.push({ type: "custom", message });
			activity.endTs = message.timestamp ?? activity.endTs;
			return;
		}
		if (message.role !== "assistant") {
			// A mid-run compaction is the run's own bookkeeping: it folds into the work row at its
			// chronological place. Only a compaction outside a run (manual /compact) stays a
			// top-level divider.
			if (message.role === "compactionSummary" && activity) {
				activity.items.push({ type: "compaction", summary: message.summary });
				activity.endTs = message.timestamp ?? activity.endTs;
				return;
			}
			// A divider landing mid-turn (a branch summary, a model switch) closes the work
			// row: later tool steps open a new one below it instead of growing the row above,
			// which would leave the divider pinned under everything that follows it.
			if (message.role === "compactionSummary" || message.role === "branchSummary" || message.role === "modelChange") {
				activity = null;
			}
			rows.push({
				kind: "plain",
				index,
				message,
				userMessageOrdinal: latestUserOrdinal,
			});
			return;
		}

		const content = message.content;
		const latestToolCallById = new Map(
			uniqueToolCalls(content.filter((part): part is ToolCallPart => part.type === "toolCall")).map((part) => [
				part.id,
				part,
			]),
		);
		const renderedToolCallIds = new Set<string>();
		let previousPartWasThinking = false;
		for (const part of content) {
			if (part.type === "thinking") {
				const cleaned = part.thinking.replace("[REDACTED]", "").trim();
				if (!cleaned) {
					previousPartWasThinking = true;
					continue;
				}
				const thinkingRow = ensureActivity(rowIdentity);
				const previousItem = thinkingRow.items.at(-1);
				if (previousPartWasThinking && previousItem?.type === "thinking") {
					previousItem.text = `${previousItem.text}\n\n${cleaned}`;
					previousItem.revisionSources.push(part);
				} else {
					thinkingRow.items.push({ type: "thinking", text: cleaned, revisionSources: [part] });
				}
				previousPartWasThinking = true;
			} else if (part.type === "toolCall" && !renderedToolCallIds.has(part.id)) {
				previousPartWasThinking = false;
				renderedToolCallIds.add(part.id);
				const call = latestToolCallById.get(part.id);
				if (!call?.name) continue;
				upsertToolStep(ensureActivity(rowIdentity), call, resultByCallId.get(call.id));
			} else if (part.type === "text" && message.stopReason === "toolUse") {
				// Keep intermediate prose inside the work fold so middle replies are not dropped,
				// without promoting toolUse turns into terminal plain bubbles.
				previousPartWasThinking = false;
				if (part.text.trim().length === 0) continue;
				const textRow = ensureActivity(rowIdentity);
				const previousItem = textRow.items.at(-1);
				if (previousItem?.type === "text") {
					previousItem.text = `${previousItem.text}\n\n${part.text}`;
					previousItem.revisionSources.push(part);
				} else {
					textRow.items.push({ type: "text", text: part.text, revisionSources: [part] });
				}
			} else {
				previousPartWasThinking = false;
			}
		}
		if (activity) activity.endTs = message.timestamp ?? activity.endTs;

		const hasText = content.some((part) => part.type === "text" && part.text.trim().length > 0);
		// `toolUse` is an intermediate model turn. Some providers (notably Kimi/OpenAI
		// compatible models) put a prose preamble beside every tool call; treating that
		// preamble as a terminal reply splits one agent run into many visible rows.
		const hasTerminalText = hasText && message.stopReason !== "toolUse";
		if (message.stopReason === "error") {
			// A failed attempt stays inside the turn's work row: Pi retries the same turn with a
			// fresh assistant message, so the retries' thinking and tools belong to this fold
			// too instead of each failure opening its own "worked for" row.
			const failureRow = ensureActivity(rowIdentity);
			failureStreak += 1;
			failureRow.items.push({
				type: "failure",
				index,
				attempt: failureStreak,
				message,
				resolvedByLaterCompaction: isResolvedByLaterCompaction(messages, index),
			});
			failureRow.endTs = message.timestamp ?? failureRow.endTs;
			return;
		}
		failureStreak = 0;
		if (hasTerminalText || message.stopReason === "aborted") {
			activity = null;
			rows.push({
				kind: "plain",
				index,
				message,
				userMessageOrdinal: latestUserOrdinal,
			});
		}
	});

	const last = rows[rows.length - 1];
	if (busy && last?.kind === "activity") last.running = true;
	return rows;
}

export function computeWorkingStatusKey(rows: readonly TimelineRow[]): string {
	const last = rows[rows.length - 1];
	if (last?.kind === "activity") {
		const lastItem = last.items[last.items.length - 1];
		if (lastItem?.type === "thinking") return "session.thinking";
		if (lastItem?.type === "step" && !lastItem.step.result) {
			switch (toolCategoryForName(lastItem.step.call.name)) {
				case "read":
					return "session.statusReading";
				case "edit":
					return "session.statusEditing";
				case "run":
					return "session.statusRunning";
				default:
					return "session.working";
			}
		}
	}
	return "session.working";
}

/** Whether to show the working status (display conditions unchanged; anti-flicker comes from pinning the layout to the sticky footer, see chat-timeline). */
export function shouldShowWorkingStatus(
	busy: boolean,
	workingVisible: boolean,
	summarizationRetry: SummarizationRetryStatus | null,
): boolean {
	return summarizationRetry !== null || (busy && workingVisible);
}
