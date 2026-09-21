import { type ExtensionUiBridge, createUnsupportedExtensionUiError } from "../../pi-protocol/extension-ui";
import type { ExtensionTerminalInputResult } from "@ling/contracts/session-extension-ui";
import { type SessionRef, sessionKey } from "@ling/contracts/session-ref";
import type { PiExtensionUiContext } from "../types";

type PiTerminalInputHandler = Parameters<PiExtensionUiContext["onTerminalInput"]>[0];
const EXTENSION_TERMINAL_INPUT_HANDLER_MAX_ITEMS = 64;

export function createPiExtensionTerminalInput(bridge: ExtensionUiBridge) {
	const { emitExtensionUiState } = bridge;

	const terminalInputHandlersBySession = new Map<string, Set<PiTerminalInputHandler>>();

	function terminalInputHandlers(ref: SessionRef): Set<PiTerminalInputHandler> {
		const key = sessionKey(ref);
		const existing = terminalInputHandlersBySession.get(key);
		if (existing) return existing;
		const created = new Set<PiTerminalInputHandler>();
		terminalInputHandlersBySession.set(key, created);
		return created;
	}

	function addPiExtensionTerminalInputHandler(ref: SessionRef, handler: PiTerminalInputHandler): () => void {
		const key = sessionKey(ref);
		const handlers = terminalInputHandlers(ref);
		if (!handlers.has(handler) && handlers.size >= EXTENSION_TERMINAL_INPUT_HANDLER_MAX_ITEMS) {
			throw createUnsupportedExtensionUiError("onTerminalInput.count");
		}
		const wasEmpty = handlers.size === 0;
		handlers.add(handler);
		if (wasEmpty) emitExtensionUiState(ref, { type: "terminalInputListening", listening: true });
		return () => {
			handlers.delete(handler);
			// A cleanup handle can outlive its extension generation. Never let an old
			// set delete the replacement generation's handlers under the same SessionRef.
			if (handlers.size === 0 && terminalInputHandlersBySession.get(key) === handlers) {
				terminalInputHandlersBySession.delete(key);
				emitExtensionUiState(ref, { type: "terminalInputListening", listening: false });
			}
		};
	}

	function dispatchPiExtensionTerminalInput(ref: SessionRef, data: string): ExtensionTerminalInputResult {
		const handlers = terminalInputHandlersBySession.get(sessionKey(ref));
		if (!handlers || handlers.size === 0) return { consumed: false, data };
		let current = data;
		for (const handler of [...handlers]) {
			const result = handler(current);
			if (result?.data !== undefined) current = result.data;
			if (result?.consume) return { consumed: true, data: current };
		}
		return { consumed: false, data: current };
	}

	function disposePiExtensionTerminalInputHandlers(ref: SessionRef): void {
		const key = sessionKey(ref);
		terminalInputHandlersBySession.delete(key);
		emitExtensionUiState(ref, { type: "terminalInputListening", listening: false });
	}
	return {
		addPiExtensionTerminalInputHandler,
		dispatchPiExtensionTerminalInput,
		disposePiExtensionTerminalInputHandlers,
	};
}

export type PiExtensionTerminalInput = ReturnType<typeof createPiExtensionTerminalInput>;
