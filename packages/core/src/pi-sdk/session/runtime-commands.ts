import { questionAnswerText } from "./question-answer-message";
import { createLingError } from "../../ling-error";
import type { ExtensionAutocompleteSuggestions, ModelState, ThinkingLevel } from "@ling/contracts/session";
import type { PiAgentSessionRuntime } from "../types";
import { completePiRuntimeCommandArgument } from "./runtime-command-completion";
import type { PiRuntimeOperationCoordinator } from "./runtime-operations";
import type { PiRuntimeProjection } from "./runtime-projection";
import type { createPiRuntimeSessionActions } from "./runtime-session-actions";
import { readSessionOrigin, recordManualForkOrigin } from "./session-origin";
import { generateSessionTitle } from "./session-title";
interface RuntimeCommandOwner {
	runtime(): PiAgentSessionRuntime;
	operations: PiRuntimeOperationCoordinator;
	isActive(): boolean;
	emitSnapshotChanged(): void;
	projectModelState: PiRuntimeProjection["projectPiRuntimeModelState"];
	sessionActions: ReturnType<typeof createPiRuntimeSessionActions>;
}
interface PiRuntimeCommands {
	retryTurn(entryId: string): Promise<void>;
	setSessionName(title: string): Promise<void>;
	generateTitle(userMessage: string): Promise<string | undefined>;
	setModel(provider: string, modelId: string): Promise<ModelState>;
	setThinkingLevel(level: ThinkingLevel): Promise<ModelState>;
	rewindToEntry(entryId: string): Promise<void>;
	getCommandArgumentCompletions(
		commandName: string,
		argumentPrefix: string,
		signal?: AbortSignal,
	): Promise<ExtensionAutocompleteSuggestions | null>;
}
export function createPiRuntimeCommands(owner: RuntimeCommandOwner): PiRuntimeCommands {
	return {
		retryTurn(entryId: string) {
			return retryTurn(owner, entryId);
		},
		setSessionName(title: string) {
			return setSessionName(owner, title);
		},
		generateTitle(userMessage: string) {
			return generateTitle(owner, userMessage);
		},
		setModel(provider: string, modelId: string) {
			return setModel(owner, provider, modelId);
		},
		setThinkingLevel(level: ThinkingLevel) {
			return setThinkingLevel(owner, level);
		},
		rewindToEntry(entryId: string) {
			return rewindToEntry(owner, entryId);
		},
		getCommandArgumentCompletions(commandName: string, argumentPrefix: string, signal?: AbortSignal) {
			return getCommandArgumentCompletions(owner, commandName, argumentPrefix, signal);
		},
	};
}

async function setSessionName(owner: RuntimeCommandOwner, title: string): Promise<void> {
	owner.operations.runSynchronously("rename the session", () => {
		const manager = owner.runtime().session.sessionManager;
		const origin = readSessionOrigin(manager.getHeader(), manager.getEntries());
		if (origin.manualFork && !origin.recorded) recordManualForkOrigin(manager);
		owner.runtime().session.setSessionName(title);
	});
}

async function generateTitle(owner: RuntimeCommandOwner, userMessage: string): Promise<string | undefined> {
	return owner.operations.run(() => {
		const model = owner.runtime().session.model;
		if (!model) return Promise.resolve(undefined);
		return generateSessionTitle(userMessage, model, owner.runtime().services);
	});
}

function setModel(owner: RuntimeCommandOwner, provider: string, modelId: string): Promise<ModelState> {
	return owner.operations.runOrderedMutation(async () => {
		const session = owner.runtime().session;
		const model = session.modelRuntime.getModel(provider, modelId);
		const available = owner
			.projectModelState(session)
			.models.some((candidate) => candidate.provider === provider && candidate.id === modelId);
		if (!model || !available) {
			throw new Error(`Unknown or unavailable model: ${provider}/${modelId}`);
		}
		await session.setModel(model);
		if (owner.isActive()) owner.emitSnapshotChanged();
		return owner.projectModelState(session);
	});
}

function setThinkingLevel(owner: RuntimeCommandOwner, level: ThinkingLevel): Promise<ModelState> {
	return owner.operations.runOrderedMutation(() => {
		const session = owner.runtime().session;
		session.setThinkingLevel(level);
		// Pi appends the level to the session file. Without this the file watcher reads Ling's
		// own append as an outside edit and refreshes the runtime from disk — setModel above
		// has carried the same emit for exactly that reason.
		if (owner.isActive()) owner.emitSnapshotChanged();
		return owner.projectModelState(session);
	});
}

async function rewindToEntry(owner: RuntimeCommandOwner, entryId: string): Promise<void> {
	// Navigating to a user message parks the leaf on its parent, so the edited resend
	// becomes a sibling of the original prompt rather than a reply to it.
	const sessionManager = owner.runtime().session.sessionManager;
	let target = entryId;
	const entry = sessionManager.getEntry(entryId);
	if (
		sessionManager.getLeafId() === entryId ||
		(entry?.type === "custom_message" && questionAnswerText({ ...entry, role: "custom" }) !== null)
	) {
		// navigateTree is a no-op on the current leaf (a prompt that never got a reply), and
		// sending then would append the edit under the original prompt. Step to the parent.
		const parentId = sessionManager.getEntry(entryId)?.parentId ?? null;
		if (parentId === null) throw new Error("Cannot rewind the only message of a session");
		target = parentId;
	}
	const result = await owner.sessionActions.navigateTree(target);
	// An extension can veto the navigation; the leaf then never moved, and sending anyway
	// would append the edit after the old branch instead of replacing it.
	if (result.cancelled) throw new Error("Rewind was cancelled by an extension");
}

async function getCommandArgumentCompletions(
	owner: RuntimeCommandOwner,
	commandName: string,
	argumentPrefix: string,
	signal?: AbortSignal,
): Promise<ExtensionAutocompleteSuggestions | null> {
	return owner.operations.run(() =>
		completePiRuntimeCommandArgument(owner.runtime().session, commandName, argumentPrefix, signal),
	);
}

/** Retry preserves the original image bytes and expanded file context inside Pi. */
async function retryTurn(owner: RuntimeCommandOwner, entryId: string): Promise<void> {
	// Claim the prompt before joining the mutation queue: runPrompt waits for that queue,
	// so putting it inside a mutation would make a retry wait for its own completion.
	return owner.operations.runPrompt(async () => {
		const { session, text, images } = await owner.operations.runOrderedMutation(async () => {
			const session = owner.runtime().session;
			const branch = session.sessionManager.getBranch();
			const user = branch.findLast(
				(entry) =>
					(entry.type === "message" && entry.message.role === "user") ||
					(entry.type === "custom_message" && questionAnswerText({ ...entry, role: "custom" }) !== null),
			);
			const content =
				user?.type === "message" && user.message.role === "user"
					? user.message.content
					: user?.type === "custom_message"
						? questionAnswerText({ ...user, role: "custom" })
						: null;
			const reply = branch.findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
			if (
				!session.isIdle ||
				user?.id !== entryId ||
				content === null ||
				reply?.type !== "message" ||
				reply.message.role !== "assistant" ||
				reply.message.stopReason !== "error"
			) {
				throw createLingError({
					code: "SESSION_LIFECYCLE_CONFLICT",
					category: "lifecycle",
					message: "Only the latest failed turn can be retried. Refresh the conversation first.",
					retryable: true,
					userAction: "retry",
				});
			}
			const text =
				typeof content === "string"
					? content
					: content
							.filter((part) => part.type === "text")
							.map((part) => part.text)
							.join("\n");
			const images = typeof content === "string" ? [] : content.filter((part) => part.type === "image");
			await rewindToEntry(owner, entryId);
			return { session, text, images };
		});
		// Questions can submit a prompt while this turn waits for an answer. Only the rewind
		// belongs in the mutation queue; holding it through the turn would block that answer.
		await session.prompt(text, { source: "interactive", images, expandPromptTemplates: false });
	});
}
