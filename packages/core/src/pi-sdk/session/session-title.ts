import { SESSION_TITLE_MAX_CHARS } from "@ling/contracts/session";
import {
	createInMemoryPiSessionManager,
	createInMemorySettingsManager,
	createPiAgentSession,
	createPiExtensionRuntime,
} from "../sdk-factories";
import type { PiAgentSessionServices, PiCreateAgentSessionOptions, PiModel, PiResourceLoader } from "../types";

/** Truncation suffix appended when a title exceeds SESSION_TITLE_MAX_CHARS; a three-character ellipsis, consistent with common UI. */
const TITLE_ELLIPSIS = "...";

/**
 * System prompt dedicated to auto-titling. The SDK has no built-in summarization; the standalone in-memory session
 * returns only a short title, in the language of the source message, with no markdown/punctuation noise.
 */
const TITLE_SYSTEM_PROMPT = [
	"You generate concise UI thread titles for a coding assistant.",
	"Return only the title text.",
	"Keep it short, usually 2 to 5 words.",
	"Use the same language as the source message.",
	"Preserve ticket and issue IDs exactly as written.",
	"No markdown, quotes, labels, or trailing punctuation.",
].join("\n");

/**
 * The SDK has no built-in title/summarization helper (see AGENTS.md) — this spins up a throwaway,
 * unpersisted, tool-less session with a dedicated system prompt to generate one. Never persisted,
 * never attached to `managedSessions`.
 */
function createTitleResourceLoader(): PiResourceLoader {
	return {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createPiExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => TITLE_SYSTEM_PROMPT,
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}

function normalizeTitle(text: string): string | undefined {
	let normalized = text.replace(/\s+/g, " ").trim();
	if (!normalized) return undefined;

	normalized = normalized.replace(/^title\s*:\s*/i, "").trim();
	while (normalized.length >= 2) {
		const first = normalized[0];
		const last = normalized[normalized.length - 1];
		const isMatchingQuotePair = (first === '"' && last === '"') || (first === "'" && last === "'");
		if (!isMatchingQuotePair) break;
		normalized = normalized.slice(1, -1).trim();
	}
	normalized = normalized.replace(/[.?!,:;]+$/g, "").trim();
	if (!normalized) return undefined;

	if (normalized.length > SESSION_TITLE_MAX_CHARS) {
		const prefixLength = SESSION_TITLE_MAX_CHARS - TITLE_ELLIPSIS.length;
		const prefix = normalized.slice(0, prefixLength);
		const lastCodeUnit = prefix.charCodeAt(prefix.length - 1);
		const completePrefix = lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff ? prefix.slice(0, -1) : prefix;
		normalized = `${completePrefix.trimEnd()}${TITLE_ELLIPSIS}`;
	}
	return normalized;
}

function lastAssistantText(messages: readonly unknown[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (
			!message ||
			typeof message !== "object" ||
			!("role" in message) ||
			message.role !== "assistant" ||
			!("content" in message) ||
			!Array.isArray(message.content)
		) {
			continue;
		}
		return message.content
			.filter(
				(part): part is { type: string; text: string } =>
					part && typeof part === "object" && part.type === "text" && typeof part.text === "string",
			)
			.map((part) => part.text)
			.join("\n");
	}
	return "";
}

/** Generates a short title from a session's first user message, or `undefined` if no title can be parsed. */
export async function generateSessionTitle(
	userMessage: string,
	model: PiModel,
	services: Pick<PiAgentSessionServices, "cwd" | "agentDir" | "modelRuntime">,
): Promise<string | undefined> {
	const trimmed = userMessage.trim();
	if (!trimmed) return undefined;

	const options: PiCreateAgentSessionOptions = {
		cwd: services.cwd,
		agentDir: services.agentDir,
		modelRuntime: services.modelRuntime,
		resourceLoader: createTitleResourceLoader(),
		settingsManager: createInMemorySettingsManager({ compaction: { enabled: false }, retry: { enabled: false } }),
		sessionManager: createInMemoryPiSessionManager(services.cwd),
		tools: [],
		model,
	};

	const { session } = await createPiAgentSession(options);
	try {
		await session.prompt(
			[
				"Generate a short UI thread title for the user's first message.",
				"Return only the title.",
				"",
				"<user_message>",
				trimmed,
				"</user_message>",
			].join("\n"),
			{ source: "interactive" },
		);
		return normalizeTitle(lastAssistantText(session.messages));
	} finally {
		session.dispose();
	}
}
