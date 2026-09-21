import type { MarkdownTransformContext, MarkdownTransformer } from "@earendil-works/pi-coding-agent";
import type { AssistantContentPart, SessionMessage, UserContentPart } from "@ling/contracts/session";
import type { PiAgentSession, PiBranchProjectionSource } from "../types";

const DEFAULT_MARKDOWN_WIDTH = 88;
/** Display-only extensions may expand text, but must not turn one bounded message into
 * an unbounded IPC payload. The original normalized text is never shortened here. */
const MAX_TRANSFORMED_MESSAGE_GROWTH_BYTES = 1024 * 1024;
const TRUNCATION_SUFFIX = "\n[truncated]";

interface MarkdownGrowthBudget {
	remainingBytes: number;
}

export function resolvePiMarkdownWidth(value: number | undefined): number {
	return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_MARKDOWN_WIDTH;
}

function boundTransformedMarkdown(markdown: string, maxBytes: number): string {
	if (Buffer.byteLength(markdown, "utf8") <= maxBytes) return markdown;
	const prefixBudget = maxBytes - Buffer.byteLength(TRUNCATION_SUFFIX, "utf8");
	let lower = 0;
	let upper = markdown.length;
	while (lower < upper) {
		const midpoint = Math.ceil((lower + upper) / 2);
		if (Buffer.byteLength(markdown.slice(0, midpoint), "utf8") <= prefixBudget) lower = midpoint;
		else upper = midpoint - 1;
	}
	return `${markdown.slice(0, lower)}${TRUNCATION_SUFFIX}`;
}

function markdownTransformers(extensions: PiBranchProjectionSource["extensions"]): readonly MarkdownTransformer[] {
	return extensions?.extensionRunner.getMarkdownTransformers() ?? [];
}

export function hasPiMarkdownTransformers(session: PiAgentSession): boolean {
	return markdownTransformers(session).length > 0;
}

function applyTransformers(
	markdown: string,
	context: MarkdownTransformContext,
	transformers: readonly MarkdownTransformer[],
	growthBudget: MarkdownGrowthBudget,
): string {
	let transformed = markdown;
	for (const transformer of transformers) {
		try {
			const next = transformer(transformed, context);
			if (typeof next === "string") {
				// The budget is shared by every Markdown section in this message. A per-section
				// ceiling still allowed hundreds of individually valid blocks to amplify one
				// normalized message far beyond the transcript/IPC boundary.
				const previousBytes = Buffer.byteLength(transformed, "utf8");
				const maxBytes = previousBytes + growthBudget.remainingBytes;
				const nextBytes = Buffer.byteLength(next, "utf8");
				// When a tiny block has no growth budget left, even the truncation marker
				// would exceed its allowance. Retain the current chain value in that case.
				const bounded =
					nextBytes <= maxBytes
						? next
						: maxBytes >= Buffer.byteLength(TRUNCATION_SUFFIX, "utf8")
							? boundTransformedMarkdown(next, maxBytes)
							: transformed;
				const growth = Buffer.byteLength(bounded, "utf8") - previousBytes;
				if (growth > 0) growthBudget.remainingBytes -= growth;
				transformed = bounded;
			}
		} catch {
			// Display transforms are fail-soft by SDK contract: preserve the current text
			// and continue so one extension cannot hide the transcript or block another.
		}
	}
	return transformed;
}

export function transformPiMarkdownMessage(
	extensions: PiBranchProjectionSource["extensions"],
	message: SessionMessage,
	options: { isStreaming: boolean; availableWidth: number },
): SessionMessage {
	const transformers = markdownTransformers(extensions);
	if (transformers.length === 0) return message;
	const availableWidth = resolvePiMarkdownWidth(options.availableWidth);
	const growthBudget = { remainingBytes: MAX_TRANSFORMED_MESSAGE_GROWTH_BYTES };
	if (message.role === "user") {
		const context: MarkdownTransformContext = {
			messageType: "user",
			// Pi's user renderer is never a streaming surface, including the user message
			// observed at the start of a live turn.
			isStreaming: false,
			availableWidth,
		};
		if (typeof message.content === "string") {
			const content = applyTransformers(message.content, context, transformers, growthBudget);
			return content === message.content ? message : { ...message, content };
		}
		const textParts = message.content.filter(
			(part): part is Extract<UserContentPart, { type: "text" }> => part.type === "text",
		);
		if (textParts.length === 0) return message;
		// Pi's TUI concatenates every user text part before invoking the transformer.
		// Ling projects that single display string while retaining non-text attachments.
		const source = textParts.map((part) => part.text).join("");
		const transformed = applyTransformers(source, context, transformers, growthBudget);
		if (textParts.length === 1 && transformed === textParts[0]?.text) return message;
		let inserted = false;
		const content: UserContentPart[] = [];
		for (const part of message.content) {
			if (part.type !== "text") {
				content.push(part);
				continue;
			}
			if (inserted) continue;
			inserted = true;
			content.push({ ...part, text: transformed });
		}
		return { ...message, content };
	}
	if (message.role !== "assistant") return message;

	let changed = false;
	const content: AssistantContentPart[] = [];
	for (let index = 0; index < message.content.length; index += 1) {
		const part = message.content[index];
		if (!part) continue;
		if (part.type === "toolCall") {
			content.push(part);
			continue;
		}
		if (part.type === "text") {
			const source = part.text.trim();
			if (source.length === 0) {
				content.push(part);
				continue;
			}
			const text = applyTransformers(
				source,
				{ messageType: "assistant", isStreaming: options.isStreaming, availableWidth },
				transformers,
				growthBudget,
			);
			if (text === part.text) content.push(part);
			else {
				changed = true;
				content.push({ ...part, text });
			}
			continue;
		}

		const run: Extract<AssistantContentPart, { type: "thinking" }>[] = [];
		let runEnd = index;
		for (; runEnd < message.content.length; runEnd += 1) {
			const candidate = message.content[runEnd];
			if (candidate?.type !== "thinking") break;
			run.push(candidate);
		}
		index = runEnd - 1;
		const thinkingBlocks = run.map((candidate) => candidate.thinking.trim()).filter((value) => value.length > 0);
		if (thinkingBlocks.length === 0) {
			content.push(...run);
			continue;
		}
		// Pi renders each consecutive thinking run as one Markdown section and invokes
		// the chain once for that section, rather than once per raw content part.
		const source = thinkingBlocks.join("\n\n");
		const thinking = applyTransformers(
			source,
			{ messageType: "assistant-thinking", isStreaming: options.isStreaming, availableWidth },
			transformers,
			growthBudget,
		);
		const first = run[0];
		if (!first) continue;
		if (run.length === 1 && thinking === first.thinking) content.push(first);
		else {
			changed = true;
			content.push({ ...first, thinking });
		}
	}
	return changed ? { ...message, content } : message;
}
