import type { AssistantUsage, SessionMessage } from "@ling/contracts/session";
import { usageModelKey } from "@ling/contracts/usage";

export interface SessionUsageSummary {
	turns: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	costTotal: number;
	compactions: number;
	lastCompactionTokensBefore: number | null;
}

export interface ContextUsage {
	percent: number;
	used: string;
	total: string;
}

export interface SessionUsageEvent {
	ordinal: number;
	timestamp: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	costTotal: number;
	models: SessionModelRef[];
	toolCalls: number;
	failedToolCalls: number;
}

export interface SessionToolUsage {
	name: string;
	calls: number;
	failures: number;
}

interface SessionModelRef {
	provider: string | null;
	model: string;
}

export interface SessionModelUsage extends SessionModelRef {
	responses: number;
	totalTokens: number;
	costTotal: number;
}

interface SessionUsageAnalysis {
	summary: SessionUsageSummary;
	events: SessionUsageEvent[];
	tools: SessionToolUsage[];
	models: SessionModelUsage[];
	unattributedTokens: number;
}

export interface SessionUsageBucket {
	startOrdinal: number;
	endOrdinal: number;
	startTimestamp: number;
	endTimestamp: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	other: number;
	total: number;
	costTotal: number;
	models: SessionModelRef[];
}

const MAX_USAGE_BUCKETS = 32;

export function buildUsageBuckets(events: readonly SessionUsageEvent[]): SessionUsageBucket[] {
	if (events.length === 0) return [];
	const bucketCount = Math.min(MAX_USAGE_BUCKETS, events.length);
	const buckets: SessionUsageBucket[] = [];
	for (let bucketIndex = 0; bucketIndex < bucketCount; bucketIndex += 1) {
		const start = Math.floor((bucketIndex * events.length) / bucketCount);
		const end = Math.floor(((bucketIndex + 1) * events.length) / bucketCount);
		const group = events.slice(start, end);
		const first = group[0];
		const last = group.at(-1);
		if (!first || !last) continue;
		const input = group.reduce((total, event) => total + event.input, 0);
		const output = group.reduce((total, event) => total + event.output, 0);
		const cacheRead = group.reduce((total, event) => total + event.cacheRead, 0);
		const cacheWrite = group.reduce((total, event) => total + event.cacheWrite, 0);
		const reportedTotal = group.reduce((total, event) => total + event.totalTokens, 0);
		const components = input + output + cacheRead + cacheWrite;
		const total = Math.max(reportedTotal, components);
		const modelsByKey = new Map<string, SessionModelRef>();
		for (const event of group) {
			for (const model of event.models) modelsByKey.set(usageModelKey(model.provider, model.model), model);
		}
		buckets.push({
			startOrdinal: first.ordinal,
			endOrdinal: last.ordinal,
			startTimestamp: first.timestamp,
			endTimestamp: last.timestamp,
			input,
			output,
			cacheRead,
			cacheWrite,
			other: Math.max(0, total - components),
			total,
			costTotal: group.reduce((cost, event) => cost + event.costTotal, 0),
			models: [...modelsByKey.values()],
		});
	}
	return buckets;
}

function usageTokenTotal(usage: AssistantUsage): number {
	return Math.max(usage.totalTokens, usage.input + usage.output + usage.cacheRead + usage.cacheWrite);
}

function hasUsage(usage: AssistantUsage): boolean {
	return usageTokenTotal(usage) > 0 || usage.cost.total > 0;
}

function addUsage(summary: SessionUsageSummary, usage: AssistantUsage): void {
	summary.input += usage.input;
	summary.output += usage.output;
	summary.cacheRead += usage.cacheRead;
	summary.cacheWrite += usage.cacheWrite;
	summary.totalTokens += usageTokenTotal(usage);
	summary.costTotal += usage.cost.total;
}

function addEventUsage(event: SessionUsageEvent, usage: AssistantUsage): void {
	event.input += usage.input;
	event.output += usage.output;
	event.cacheRead += usage.cacheRead;
	event.cacheWrite += usage.cacheWrite;
	event.totalTokens += usageTokenTotal(usage);
	event.costTotal += usage.cost.total;
}

function formatContextCount(count: number): string {
	if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}m`;
	if (count >= 10_000) return `${Math.round(count / 1000)}k`;
	if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
	return String(count);
}

export function deriveContextUsage(
	contextTokens: number | undefined,
	contextWindow: number | undefined,
): ContextUsage | null {
	if (contextTokens === undefined || contextWindow === undefined || contextWindow <= 0) return null;
	return {
		percent: Math.max(0, Math.min(100, Math.round((contextTokens / contextWindow) * 100))),
		used: formatContextCount(contextTokens),
		total: formatContextCount(contextWindow),
	};
}

/** Return the newest completed assistant usage, unless a later context summary made it stale. */
export function latestContextTokens(messages: readonly SessionMessage[]): number | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role === "compactionSummary" || message?.role === "branchSummary") return undefined;
		if (message?.role === "assistant" && usageTokenTotal(message.usage) > 0) {
			return usageTokenTotal(message.usage);
		}
	}
	return undefined;
}

export function analyzeSessionUsage(messages: readonly SessionMessage[]): SessionUsageAnalysis {
	const summary: SessionUsageSummary = {
		turns: 0,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		costTotal: 0,
		compactions: 0,
		lastCompactionTokensBefore: null,
	};
	const events: SessionUsageEvent[] = [];
	const toolsByName = new Map<string, SessionToolUsage>();
	const modelsByKey = new Map<string, SessionModelUsage>();
	const callsById = new Map<string, SessionToolUsage>();
	const failedCallIds = new Set<string>();

	const newEvent = (timestamp: number): SessionUsageEvent => ({
		ordinal: events.length + 1,
		timestamp,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		costTotal: 0,
		models: [],
		toolCalls: 0,
		failedToolCalls: 0,
	});
	const commitEvent = (event: SessionUsageEvent): void => {
		if (
			event.totalTokens > 0 ||
			event.input > 0 ||
			event.output > 0 ||
			event.cacheRead > 0 ||
			event.cacheWrite > 0 ||
			event.costTotal > 0 ||
			event.toolCalls > 0 ||
			event.failedToolCalls > 0
		) {
			events.push(event);
		}
	};
	const trackUsage = (event: SessionUsageEvent, usage: AssistantUsage): boolean => {
		if (!hasUsage(usage)) return false;
		addUsage(summary, usage);
		addEventUsage(event, usage);
		return true;
	};
	const registerToolCall = (id: string, name: string): { tool: SessionToolUsage; added: boolean } => {
		const existing = callsById.get(id);
		if (existing) return { tool: existing, added: false };
		let tool = toolsByName.get(name);
		if (!tool) {
			tool = { name, calls: 0, failures: 0 };
			toolsByName.set(name, tool);
		}
		tool.calls += 1;
		callsById.set(id, tool);
		return { tool, added: true };
	};

	for (const message of messages) {
		const timestamp = message.occurredAt;
		if (message.role === "assistant") {
			const event = newEvent(timestamp);
			for (const part of message.content) {
				if (part.type === "toolCall" && registerToolCall(part.id, part.name).added) event.toolCalls += 1;
			}
			if (trackUsage(event, message.usage)) {
				summary.turns += 1;
				if (message.model) {
					const modelRef = { provider: message.provider ?? null, model: message.model };
					event.models.push(modelRef);
					const key = usageModelKey(modelRef.provider, modelRef.model);
					const model = modelsByKey.get(key);
					if (model) {
						model.responses += 1;
						model.totalTokens += usageTokenTotal(message.usage);
						model.costTotal += message.usage.cost.total;
					} else {
						modelsByKey.set(key, {
							...modelRef,
							responses: 1,
							totalTokens: usageTokenTotal(message.usage),
							costTotal: message.usage.cost.total,
						});
					}
				}
			}
			commitEvent(event);
			continue;
		}
		if (message.role === "toolResult") {
			const event = newEvent(timestamp);
			const call = registerToolCall(message.toolCallId, message.toolName);
			if (call.added) event.toolCalls += 1;
			if (message.isError && !failedCallIds.has(message.toolCallId)) {
				failedCallIds.add(message.toolCallId);
				call.tool.failures += 1;
				event.failedToolCalls = 1;
			}
			if (message.usage) trackUsage(event, message.usage);
			commitEvent(event);
			continue;
		}
		if (message.role === "compactionSummary") {
			summary.compactions += 1;
			summary.lastCompactionTokensBefore = message.tokensBefore;
			if (message.usage) {
				const event = newEvent(timestamp);
				trackUsage(event, message.usage);
				commitEvent(event);
			}
			continue;
		}
		if (message.role === "branchSummary" && message.usage) {
			const event = newEvent(timestamp);
			trackUsage(event, message.usage);
			commitEvent(event);
		}
	}

	const models = [...modelsByKey.values()].toSorted(
		(left, right) => right.totalTokens - left.totalTokens || left.model.localeCompare(right.model),
	);
	return {
		summary,
		events,
		tools: [...toolsByName.values()].toSorted(
			(left, right) =>
				right.calls - left.calls || right.failures - left.failures || left.name.localeCompare(right.name),
		),
		models,
		unattributedTokens: Math.max(
			0,
			summary.totalTokens - models.reduce((total, model) => total + model.totalTokens, 0),
		),
	};
}
