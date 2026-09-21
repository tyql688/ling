import { useDomainApi } from "@renderer/lib/host-api-context";
import type {
	ExtensionTerminalInputReplayRequest,
	ExtensionTerminalInputResult,
} from "@ling/contracts/session-extension-ui";
import type { SessionRef } from "@ling/contracts/session-ref";
import {
	applyMacControlTextDefault,
	captureExtensionKeyReplay,
	type ExtensionKeyReplay,
	isEditableTextTarget,
	matchesReplayKeyDown,
} from "@renderer/features/chat/extension-ui/extension-terminal-input-replay";
import { extensionKeyData, isExtensionShortcutKey } from "@renderer/features/chat/extension-ui/extension-terminal-keys";
import { useEffect, useRef } from "react";

const REPLAY_EVENT_TIMEOUT_MS = 1_000;
const EXTENSION_INPUT_QUEUE_CAPACITY = 64;

interface KeyDownReplayDelivery {
	defaultPrevented: boolean;
	targetMatched: boolean;
}

interface PendingKeyDownReplay {
	replay: ExtensionKeyReplay;
	target: Element;
	resolve(delivery: KeyDownReplayDelivery): void;
}

interface PendingTextReplay {
	request: ExtensionTerminalInputReplayRequest;
	target: Element;
	resolve(targetMatched: boolean): void;
}

function matchesTextReplay(event: InputEvent, request: ExtensionTerminalInputReplayRequest): boolean {
	if (request.type === "insertText") return event.inputType === "insertText" && event.data === request.text;
	if (request.type !== "char") return false;
	if (request.keyCode === "Enter") {
		return event.inputType === "insertLineBreak" || event.inputType === "insertParagraph";
	}
	const data = request.keyCode === "Space" ? " " : request.keyCode;
	return event.inputType === "insertText" && event.data === data;
}

function eventTimeout<Result>(
	milliseconds: number,
	message: string,
): {
	promise: Promise<Result>;
	cancel(): void;
} {
	let timer = 0;
	return {
		promise: new Promise<Result>((_resolve, reject) => {
			timer = window.setTimeout(() => reject(new Error(message)), milliseconds);
		}),
		cancel: () => window.clearTimeout(timer),
	};
}

export function useExtensionTerminalInput(options: {
	activeSessionRef: SessionRef | null;
	terminalInputListening: boolean;
	/** False while the workspace shell is hidden (e.g. settings is open): captured input must not steal hidden-terminal keystrokes. */
	enabled: boolean;
	showCommandError(error: unknown): void;
}): void {
	const hostUiApi = useDomainApi("ui");
	const hostSessionApi = useDomainApi("session");

	const { activeSessionRef, terminalInputListening, enabled, showCommandError } = options;
	const pendingKeyDownReplayRef = useRef<PendingKeyDownReplay | null>(null);
	const pendingTextReplayRef = useRef<PendingTextReplay | null>(null);
	const manualTextDefaultTargetRef = useRef<Element | null>(null);

	useEffect(() => {
		if (!enabled) return;
		if (!hostUiApi.capabilities.extensionInputReplay || !activeSessionRef || !terminalInputListening) return;
		const sessionRef = activeSessionRef;
		let disposed = false;
		let inputTail = Promise.resolve();
		let pendingInputCount = 0;
		let queueCapacityReported = false;
		const nativeInputGuards = new Map<Element, number>();
		const nativeInputGuardTimers = new Set<number>();

		function guardOriginalNativeInput(target: Element): void {
			nativeInputGuards.set(target, (nativeInputGuards.get(target) ?? 0) + 1);
			const timer = window.setTimeout(() => {
				nativeInputGuardTimers.delete(timer);
				const remaining = (nativeInputGuards.get(target) ?? 1) - 1;
				if (remaining <= 0) nativeInputGuards.delete(target);
				else nativeInputGuards.set(target, remaining);
			}, 0);
			nativeInputGuardTimers.add(timer);
		}

		function handleBeforeInput(event: InputEvent): void {
			const pending = pendingTextReplayRef.current;
			if (pending && matchesTextReplay(event, pending.request)) {
				pendingTextReplayRef.current = null;
				const targetMatched = event.target === pending.target;
				if (!targetMatched) {
					event.preventDefault();
					event.stopImmediatePropagation();
				}
				// The browser can run a microtask checkpoint between event listeners. React's
				// delegated handler may therefore not have applied the input/default action yet.
				// Resolve in the next task so replay ordering observes the completed DOM event.
				window.setTimeout(() => pending.resolve(targetMatched), 0);
				return;
			}
			if (event.target === manualTextDefaultTargetRef.current) return;
			if (event.target instanceof Element && nativeInputGuards.has(event.target)) {
				event.preventDefault();
				event.stopImmediatePropagation();
			}
		}

		async function replayTextInput(target: Element, request: ExtensionTerminalInputReplayRequest): Promise<void> {
			if (disposed || !target.isConnected || document.activeElement !== target) return;
			let resolveDelivery!: (targetMatched: boolean) => void;
			const delivery = new Promise<boolean>((resolve) => {
				resolveDelivery = resolve;
			});
			const pending: PendingTextReplay = { request, target, resolve: resolveDelivery };
			pendingTextReplayRef.current = pending;
			const timeout = eventTimeout<boolean>(
				REPLAY_EVENT_TIMEOUT_MS,
				"The desktop shell did not deliver the replayed extension text input",
			);
			try {
				await hostSessionApi.replayExtensionTerminalInput(request);
				// A navigation or session replacement can move focus between keyDown and
				// beforeinput. The capture handler already suppresses delivery to the new
				// target, so cancelling the stale replay is the safe completion.
				await Promise.race([delivery, timeout.promise]);
			} finally {
				timeout.cancel();
				if (pendingTextReplayRef.current === pending) pendingTextReplayRef.current = null;
			}
		}

		async function replayUnconsumedKey(target: Element, replay: ExtensionKeyReplay): Promise<void> {
			if (disposed || !target.isConnected || document.activeElement !== target) return;

			let resolveKeyDown!: (delivery: KeyDownReplayDelivery) => void;
			const keyDownDelivery = new Promise<KeyDownReplayDelivery>((resolve) => {
				resolveKeyDown = resolve;
			});
			const pending: PendingKeyDownReplay = { replay, target, resolve: resolveKeyDown };
			pendingKeyDownReplayRef.current = pending;
			let keyDownSent = false;
			try {
				try {
					await hostSessionApi.replayExtensionTerminalInput({
						type: "keyDown",
						keyCode: replay.keyDownKeyCode,
						modifiers: replay.modifiers,
					});
					keyDownSent = true;
				} catch (error) {
					if (pendingKeyDownReplayRef.current === pending) pendingKeyDownReplayRef.current = null;
					throw error;
				}
				const timeout = eventTimeout<KeyDownReplayDelivery>(
					REPLAY_EVENT_TIMEOUT_MS,
					"The desktop shell did not deliver the replayed extension key input",
				);
				let delivery: KeyDownReplayDelivery;
				try {
					delivery = await Promise.race([keyDownDelivery, timeout.promise]);
				} finally {
					timeout.cancel();
				}
				if (!delivery.targetMatched) return;
				if (delivery.defaultPrevented || disposed || !target.isConnected || document.activeElement !== target) {
					return;
				}
				manualTextDefaultTargetRef.current = target;
				try {
					if (applyMacControlTextDefault(target, replay)) return;
				} finally {
					if (manualTextDefaultTargetRef.current === target) manualTextDefaultTargetRef.current = null;
				}
				if (replay.textRequest !== null && isEditableTextTarget(target)) {
					await replayTextInput(target, replay.textRequest);
				}
			} finally {
				if (pendingKeyDownReplayRef.current === pending) pendingKeyDownReplayRef.current = null;
				if (keyDownSent) {
					await hostSessionApi.replayExtensionTerminalInput({
						type: "keyUp",
						keyCode: replay.keyDownKeyCode,
						modifiers: replay.modifiers,
					});
				}
			}
		}

		async function routeExtensionTerminalInput(target: Element, data: string, replay: ExtensionKeyReplay) {
			if (disposed || !target.isConnected || document.activeElement !== target) return;
			let result: ExtensionTerminalInputResult;
			try {
				result = await hostSessionApi.dispatchExtensionTerminalInput({ ref: sessionRef, data });
			} catch (error) {
				try {
					await replayUnconsumedKey(target, replay);
				} catch (replayError) {
					throw new AggregateError(
						[error, replayError],
						"Extension input failed and the original key could not be replayed",
					);
				}
				throw error;
			}
			if (disposed || result.consumed) return;
			if (result.data !== data) {
				throw new Error("Extension capability is not supported: onTerminalInput.dataRewrite");
			}
			await replayUnconsumedKey(target, replay);
		}

		function handleExtensionTerminalInput(event: KeyboardEvent) {
			const pendingReplay = pendingKeyDownReplayRef.current;
			if (pendingReplay !== null && matchesReplayKeyDown(event, pendingReplay.replay)) {
				pendingKeyDownReplayRef.current = null;
				const targetMatched = event.target === pendingReplay.target;
				if (!targetMatched) {
					event.preventDefault();
					event.stopImmediatePropagation();
				}
				// A microtask can run before React's delegated key handler. Waiting one task is
				// required to observe preventDefault from composer submit/completion handlers.
				window.setTimeout(() => pendingReplay.resolve({ targetMatched, defaultPrevented: event.defaultPrevented }), 0);
				return;
			}
			if (event.defaultPrevented) return;
			if (!(event.target instanceof Element)) return;
			if (event.target.closest("[data-extension-custom-panel]")) return;
			if (!event.target.closest("[data-session-composer]")) return;
			// Plain typing keys stay local: only shortcut chords are worth the extension
			// round-trip, and routing every keystroke made deletion and IME feel laggy.
			if (!isExtensionShortcutKey(event)) return;
			const data = extensionKeyData(event);
			if (data === null) return;
			const replay = captureExtensionKeyReplay(event);
			if (replay === null) return;
			if (pendingInputCount >= EXTENSION_INPUT_QUEUE_CAPACITY) {
				if (!queueCapacityReported) {
					queueCapacityReported = true;
					showCommandError(new Error("Extension keyboard input is busy. The key was handled locally instead."));
				}
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			const target = event.target;
			guardOriginalNativeInput(target);
			pendingInputCount += 1;
			inputTail = inputTail
				.then(() => routeExtensionTerminalInput(target, data, replay))
				.catch((error: unknown) => showCommandError(error))
				.finally(() => {
					pendingInputCount -= 1;
					if (pendingInputCount < EXTENSION_INPUT_QUEUE_CAPACITY) queueCapacityReported = false;
				});
		}

		window.addEventListener("keydown", handleExtensionTerminalInput, { capture: true });
		window.addEventListener("beforeinput", handleBeforeInput, { capture: true });
		return () => {
			disposed = true;
			for (const timer of nativeInputGuardTimers) window.clearTimeout(timer);
			nativeInputGuardTimers.clear();
			nativeInputGuards.clear();
			const pendingKeyDown = pendingKeyDownReplayRef.current;
			if (pendingKeyDown) {
				pendingKeyDownReplayRef.current = null;
				pendingKeyDown.resolve({ targetMatched: false, defaultPrevented: true });
			}
			const pendingText = pendingTextReplayRef.current;
			if (pendingText) {
				pendingTextReplayRef.current = null;
				pendingText.resolve(false);
			}
			manualTextDefaultTargetRef.current = null;
			window.removeEventListener("keydown", handleExtensionTerminalInput, { capture: true });
			window.removeEventListener("beforeinput", handleBeforeInput, { capture: true });
		};
	}, [hostUiApi, hostSessionApi, activeSessionRef, enabled, terminalInputListening, showCommandError]);
}
