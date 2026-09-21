import type { SessionMessage, ToolResultSessionMessage } from "@ling/contracts/session";
import { createLingError } from "@ling/core/ling-error";
import { inspectPiSessionEntryIdentity } from "../../transcript/session-entry-identity";
import { renderPiCustomEntry, renderPiCustomMessage } from "../extensions/extension-message-renderer";
import { createPiToolRendererProjection } from "../extensions/extension-tool-renderer";
import { transformPiMarkdownMessage } from "../extensions/markdown-transformer";
import { type PiAgentSession, type PiBranchProjectionSource, piBranchProjectionSource } from "../types";
import { normalizePiMessage } from "./message-normalizer";
import { readAssistantGeneration } from "./assistant-generation";

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
				return part.text;
			}
			return "";
		})
		.filter((text) => text.length > 0)
		.join("\n");
}

function persistedMessageOptions(entry: { id: unknown; timestamp: unknown }) {
	const result = inspectPiSessionEntryIdentity(entry);
	if (result.status === "valid") return result.identity;
	if (result.reason === "identity") throw new Error("Pi session entry is missing its durable identity");
	throw new Error("Pi session entry has an invalid timestamp");
}

/** Projects the current Pi branch without leaking raw SDK entry types beyond the Pi boundary. */
export function projectPiBranchMessages(
	source: PiBranchProjectionSource,
	options: {
		markdownWidth?: number;
		includeLiveTurn?: boolean;
		/** Archived reads have no runtime to fetch a deferred body from, so they keep tool output. */
		deferToolResults?: boolean;
	} = {},
): SessionMessage[] {
	const messages: SessionMessage[] = [];
	const deferToolResults = options.deferToolResults ?? true;
	const toolRenderer = createPiToolRendererProjection(source);
	const branch = source.sessionManager.getBranch();
	// A running turn keeps full results so resync never replaces live output with unloaded details.
	const liveStart = options.includeLiveTurn
		? Math.max(
				0,
				branch.findLastIndex((entry) => entry.type === "message" && entry.message.role === "user"),
			)
		: branch.length;
	for (const [index, entry] of branch.entries()) {
		const options = persistedMessageOptions(entry);
		if (entry.type === "message") {
			if (entry.message.role === "system") continue;
			const message = normalizePiMessage(
				toolRenderer.project(entry.message, true, deferToolResults && index < liveStart, entry.id),
				options,
			);
			const duration =
				message.role === "assistant" ? readAssistantGeneration(source.sessionManager, entry.id) : undefined;
			messages.push(
				message.role === "assistant" && duration !== undefined
					? { ...message, generationDurationMs: duration }
					: message,
			);
		} else if (entry.type === "model_change") {
			messages.push(
				normalizePiMessage(
					{
						role: "modelChange",
						provider: entry.provider,
						modelId: entry.modelId,
						timestamp: options.occurredAt,
					},
					options,
				),
			);
		} else if (entry.type === "compaction") {
			messages.push(
				normalizePiMessage(
					{
						role: "compactionSummary",
						summary: entry.summary,
						tokensBefore: entry.tokensBefore,
						...(entry.usage ? { usage: entry.usage } : {}),
						timestamp: options.occurredAt,
					},
					options,
				),
			);
		} else if (entry.type === "branch_summary") {
			messages.push(
				normalizePiMessage(
					{
						role: "branchSummary",
						summary: entry.summary,
						fromId: entry.fromId,
						...(entry.usage ? { usage: entry.usage } : {}),
						timestamp: options.occurredAt,
					},
					options,
				),
			);
		} else if (entry.type === "custom") {
			const rendered = renderPiCustomEntry(source.extensions, entry);
			if (rendered !== undefined) {
				messages.push(
					normalizePiMessage(
						{
							role: "custom",
							customType: entry.customType,
							content: "",
							display: true,
							rendered,
							timestamp: options.occurredAt,
						},
						options,
					),
				);
			}
		} else if (entry.type === "custom_message" && entry.display) {
			const normalized = normalizePiMessage(
				{
					role: "custom",
					customType: entry.customType,
					content: entry.content,
					display: entry.display,
					...(entry.details === undefined ? {} : { details: entry.details }),
					timestamp: options.occurredAt,
				},
				options,
			);
			if (normalized.role !== "custom") {
				messages.push(normalized);
				continue;
			}
			const rendered = renderPiCustomMessage(source.extensions, normalized);
			messages.push(rendered === undefined ? normalized : normalizePiMessage({ ...normalized, rendered }, options));
		}
	}
	if (options.markdownWidth === undefined) return messages;
	return messages.map((message) =>
		transformPiMarkdownMessage(source.extensions, message, {
			isStreaming: false,
			availableWidth: options.markdownWidth ?? 0,
		}),
	);
}

/** Summary metadata must not normalize and render the entire transcript. The raw branch already
 * carries enough structure to count projected rows and find the opening prompt; only custom
 * entries need their extension renderer consulted to preserve the projection's inclusion rule. */
export function summarizePiBranchMessages(session: PiAgentSession): { messageCount: number; preview: string } {
	let messageCount = 0;
	let preview = "";
	let foundUserMessage = false;
	for (const entry of session.sessionManager.getBranch()) {
		if (entry.type === "message") {
			if (entry.message.role === "system") continue;
			messageCount += 1;
			if (!foundUserMessage && entry.message.role === "user") {
				foundUserMessage = true;
				preview = textFromContent(entry.message.content);
			}
			continue;
		}
		if (entry.type === "model_change" || entry.type === "compaction" || entry.type === "branch_summary") {
			messageCount += 1;
			continue;
		}
		if (entry.type === "custom") {
			if (renderPiCustomEntry(session, entry) !== undefined) messageCount += 1;
			continue;
		}
		if (entry.type === "custom_message" && entry.display) messageCount += 1;
	}
	return { messageCount, preview };
}

/** Resolve a single persisted tool result, including its extension rendering, only on disclosure. */
export function projectPiToolResult(
	session: PiAgentSession,
	entryId: string,
	markdownWidth: number,
): ToolResultSessionMessage {
	const branch = session.sessionManager.getBranch();
	const entryIndex = branch.findIndex((candidate) => candidate.id === entryId);
	const entry = branch[entryIndex];
	if (entry?.type !== "message" || entry.message.role !== "toolResult") {
		throw createLingError({
			code: "INVALID_REQUEST",
			category: "validation",
			message: "The tool result is not on the current session branch.",
			retryable: false,
		});
	}
	const result = entry.message;
	const renderer = createPiToolRendererProjection(piBranchProjectionSource(session));
	const callEntry = branch.findLast(
		(candidate, index) =>
			index < entryIndex &&
			candidate.type === "message" &&
			candidate.message.role === "assistant" &&
			candidate.message.content.some((part) => part.type === "toolCall" && part.id === result.toolCallId),
	);
	if (callEntry?.type === "message") renderer.project(callEntry.message);
	const message = normalizePiMessage(renderer.project(result, true, false, entry.id), persistedMessageOptions(entry));
	const projected = transformPiMarkdownMessage(session, message, {
		isStreaming: false,
		availableWidth: markdownWidth,
	});
	if (projected.role !== "toolResult") throw new Error("The tool result projection has an invalid role.");
	return projected;
}
