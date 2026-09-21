import type { SessionRef } from "@ling/contracts/session";
import type { PiTurnContext, PiTurnFallbackCapture, PiTurnLifecycleHost } from "@ling/core/pi-protocol/turn-review";
import type {
	PiInlineExtension,
	PiLoadExtensionsResult,
	PiSessionManager,
	PiToolCallEvent,
	PiToolResultEvent,
} from "../types";

/** Inline extension name for the turn-start boundary; hooked on agent_start and must stay stable for diagnostics and dedupe. */
const START_EXTENSION_NAME = "ling-turn-boundary-start";
/** Inline extension name for the turn-finish boundary; hooked on agent_settled. */
const FINISH_EXTENSION_NAME = "ling-turn-boundary-finish";
/** Inline extension path shape `<inline:name>`, matching Pi's loader convention for non-disk extensions. */
const START_EXTENSION_PATH = `<inline:${START_EXTENSION_NAME}>`;

interface PiTurnLifecycleBinding {
	start(timestamp: number): Promise<void>;
	toolCall(event: PiToolCallEvent): Promise<void>;
	toolResult(event: PiToolResultEvent): Promise<void>;
	finish(timestamp: number): Promise<void>;
}

export function userMessageEntryIds(sessionManager: PiSessionManager): ReadonlySet<string> {
	const ids = new Set<string>();
	for (const entry of sessionManager.getBranch()) {
		if (entry.type === "message" && entry.message.role === "user") ids.add(entry.id);
	}
	return ids;
}

/** agent_start precedes persistence of the prompting user message. Link the captured
 * turn only after agent_settled, choosing the first new user entry so retries and
 * queued continuations cannot shift the card to a later prompt. */
export function firstUserMessageEntryIdAfter(
	sessionManager: PiSessionManager,
	previousEntryIds: ReadonlySet<string>,
): string | null {
	for (const entry of sessionManager.getBranch()) {
		if (entry.type === "message" && entry.message.role === "user" && !previousEntryIds.has(entry.id)) {
			return entry.id;
		}
	}
	return null;
}

function moveStartExtensionFirst(result: PiLoadExtensionsResult): PiLoadExtensionsResult {
	const startIndex = result.extensions.findIndex((extension) => extension.path === START_EXTENSION_PATH);
	if (startIndex === -1) throw new Error("Ling turn-start extension failed to load");
	const start = result.extensions[startIndex];
	if (start === undefined) throw new Error("Ling turn-start extension failed to load");
	return {
		...result,
		extensions: [start, ...result.extensions.filter((_, index) => index !== startIndex)],
	};
}

export function createPiTurnLifecycle(host: PiTurnLifecycleHost) {
	let disposed = false;

	const bindings = new WeakMap<PiSessionManager, PiTurnLifecycleBinding>();
	function runPiTurnLifecycleStart(ref: SessionRef, timestamp: number, context: PiTurnContext): Promise<void> {
		return host.start(ref, timestamp, context);
	}

	function runPiTurnLifecycleFinish(
		ref: SessionRef,
		timestamp: number,
		fallback: PiTurnFallbackCapture,
		context: PiTurnContext,
	): Promise<void> {
		return host.finish(ref, timestamp, fallback, context);
	}

	function bindPiTurnLifecycle(sessionManager: PiSessionManager, binding: PiTurnLifecycleBinding): () => void {
		if (disposed) throw new Error("Pi turn lifecycle has been disposed");
		if (bindings.has(sessionManager)) throw new Error("Pi turn lifecycle is already bound for this session runtime");
		bindings.set(sessionManager, binding);
		return () => {
			if (bindings.get(sessionManager) === binding) bindings.delete(sessionManager);
		};
	}

	function requireBinding(sessionManager: PiSessionManager): PiTurnLifecycleBinding {
		if (disposed) throw new Error("Pi turn lifecycle has been disposed");
		const binding = bindings.get(sessionManager);
		if (binding === undefined) throw new Error("Pi turn lifecycle boundary fired without a bound Ling runtime");
		return binding;
	}

	function createPiTurnLifecycleResourceOptions(sessionManager: PiSessionManager): {
		extensionFactories: PiInlineExtension[];
		extensionsOverride(base: PiLoadExtensionsResult): PiLoadExtensionsResult;
	} {
		const start: PiInlineExtension = {
			name: START_EXTENSION_NAME,
			hidden: true,
			factory(pi) {
				pi.on("agent_start", async () => {
					await requireBinding(sessionManager).start(Date.now());
				});
				pi.on("tool_call", async (event) => {
					try {
						await requireBinding(sessionManager).toolCall(event);
					} catch {
						// ExtensionRunner intentionally propagates tool_call handler errors.
						// Review tracking is observational and must never block a user tool.
					}
				});
			},
		};
		const finish: PiInlineExtension = {
			name: FINISH_EXTENSION_NAME,
			hidden: true,
			factory(pi) {
				pi.on("tool_result", async (event) => {
					await requireBinding(sessionManager).toolResult(event);
				});
				pi.on("agent_settled", async () => {
					await requireBinding(sessionManager).finish(Date.now());
				});
			},
		};
		return {
			extensionFactories: [start, finish],
			// Inline factories are appended after user extensions by Pi. Move only the
			// start boundary to the front; the finish boundary intentionally remains last.
			extensionsOverride: moveStartExtensionFirst,
		};
	}

	function dispose(): void {
		disposed = true;
	}
	return {
		runPiTurnLifecycleStart,
		runPiTurnLifecycleFinish,
		bindPiTurnLifecycle,
		createPiTurnLifecycleResourceOptions,
		dispose,
	};
}

export type PiTurnLifecycle = ReturnType<typeof createPiTurnLifecycle>;
