import { useDomainApi } from "@renderer/lib/host-api-context";
import type {
	CancelSessionOperationRequest,
	ExtensionAutocompleteSuggestions,
	SessionRef,
} from "@ling/contracts/session";
import {
	createBuiltinSessionOperationRef,
	SESSION_AUTOCOMPLETE_OWNER_ID,
	SESSION_COMMAND_ARGUMENT_COMPLETION_OWNER_ID,
} from "@ling/contracts/owner-ref";
import { formatRequestError, isExpectedCancellation } from "@renderer/lib/errors";
import { type RefObject, useEffect, useRef, useState } from "react";
import { canApplyExtensionAutocompleteResult } from "../extension-ui/extension-autocomplete-apply";
import {
	bindSessionRuntimeInputValue,
	currentSessionRuntimeInputBoundValue,
	type SessionRuntimeInputBoundValue,
} from "../session-runtime-bound-value";
import type { ComposerEditorHandle } from "./composer-editor";

/**
 * Deadline for a single completion IPC. Completion is an assistive path, so 10s covers slow
 * extensions; deadline failures surface as completion feedback without blocking typing
 * or marking the session itself as failed.
 */
const COMPLETION_REQUEST_DEADLINE_MS = 10_000;
/**
 * Keystroke debounce. Cancel/reissue per character would flood main IPC; ~120ms tracks typing
 * cadence, so a burst of keystrokes only sends the final request.
 */
const COMPLETION_DEBOUNCE_MS = 120;

interface ComposerCompletionParams {
	draftKey: string;
	sessionRef: SessionRef;
	runtimeBinding: { runtimeId: string | null; generation: number };
	text: string;
	cursorOffset: number;
	commandArgumentRequest: { commandName: string; argumentPrefix: string } | null;
	onCommandError: (message: string) => void;
	composerInputRevisionRef: RefObject<number>;
	composerTextRef: RefObject<string>;
	composerCursorOffsetRef: RefObject<number>;
	editorRef: RefObject<ComposerEditorHandle | null>;
	/** Returning false means the input was rejected for exceeding the limit; the completion result must not be applied */
	setText: (value: string) => boolean;
	setCursorOffset: (value: number) => void;
}

export function useComposerCompletions({
	draftKey,
	sessionRef,
	runtimeBinding,
	text,
	cursorOffset,
	commandArgumentRequest,
	onCommandError,
	composerInputRevisionRef,
	composerTextRef,
	composerCursorOffsetRef,
	editorRef,
	setText,
	setCursorOffset,
}: ComposerCompletionParams) {
	const hostSessionApi = useDomainApi("session");

	const [extensionAutocompleteState, setExtensionAutocomplete] =
		useState<SessionRuntimeInputBoundValue<ExtensionAutocompleteSuggestions> | null>(null);
	const [commandArgumentCompletionsState, setCommandArgumentCompletions] =
		useState<SessionRuntimeInputBoundValue<ExtensionAutocompleteSuggestions> | null>(null);
	const autocompleteRequestSequence = useRef(0);
	const autocompleteApplySequence = useRef(0);
	const commandArgumentRequestSequence = useRef(0);
	const focusFrameRef = useRef<number | null>(null);
	const scheduleFocus = (focus: () => void): void => {
		if (focusFrameRef.current !== null) window.cancelAnimationFrame(focusFrameRef.current);
		focusFrameRef.current = window.requestAnimationFrame(() => {
			focusFrameRef.current = null;
			focus();
		});
	};
	useEffect(
		() => () => {
			autocompleteApplySequence.current += 1;
			if (focusFrameRef.current !== null) window.cancelAnimationFrame(focusFrameRef.current);
			focusFrameRef.current = null;
		},
		[],
	);

	useEffect(() => {
		const requestSequence = ++autocompleteRequestSequence.current;
		setExtensionAutocomplete(null);
		const runtimeId = runtimeBinding.runtimeId;
		const generation = runtimeBinding.generation;
		const inputRevision = composerInputRevisionRef.current;
		if (text.length === 0 || runtimeId === null) {
			return;
		}
		const operation = createBuiltinSessionOperationRef(
			crypto.randomUUID(),
			SESSION_AUTOCOMPLETE_OWNER_ID,
			sessionRef,
			generation,
		);
		const cancellation: CancelSessionOperationRequest = {
			operation,
			ref: sessionRef,
			runtimeId,
			generation,
		};
		let requestPending = false;
		const timer = window.setTimeout(() => {
			requestPending = true;
			void hostSessionApi
				.getExtensionAutocomplete({
					...cancellation,
					deadlineAt: Date.now() + COMPLETION_REQUEST_DEADLINE_MS,
					text,
					cursorOffset,
				})
				.then((result) => {
					requestPending = false;
					if (autocompleteRequestSequence.current !== requestSequence) return;
					const suggestions = result;
					setExtensionAutocomplete(
						suggestions && suggestions.items.length > 0
							? bindSessionRuntimeInputValue(
									{
										identity: { refKey: draftKey, runtimeId, generation },
										inputRevision,
										text,
										cursorOffset,
									},
									suggestions,
								)
							: null,
					);
				})
				.catch((cause: unknown) => {
					requestPending = false;
					if (autocompleteRequestSequence.current !== requestSequence) return;
					setExtensionAutocomplete(null);
					if (!isExpectedCancellation(cause)) onCommandError(formatRequestError(cause));
				});
		}, COMPLETION_DEBOUNCE_MS);
		return () => {
			autocompleteRequestSequence.current += 1;
			window.clearTimeout(timer);
			// A cleared debounce has no Host operation to cancel. Cancelling it anyway
			// turns a burst of local edits into an unbounded stream of cancellation RPCs.
			if (!requestPending) return;
			void hostSessionApi
				.cancelRequest(cancellation)
				.catch((cause: unknown) => onCommandError(formatRequestError(cause)));
		};
	}, [
		hostSessionApi,
		draftKey,
		sessionRef,
		text,
		cursorOffset,
		onCommandError,
		runtimeBinding.generation,
		runtimeBinding.runtimeId,
		composerInputRevisionRef,
	]);
	useEffect(() => {
		const requestSequence = ++commandArgumentRequestSequence.current;
		const runtimeId = runtimeBinding.runtimeId;
		const generation = runtimeBinding.generation;
		const inputRevision = composerInputRevisionRef.current;
		if (!commandArgumentRequest || runtimeId === null) {
			setCommandArgumentCompletions(null);
			return;
		}
		const operation = createBuiltinSessionOperationRef(
			crypto.randomUUID(),
			SESSION_COMMAND_ARGUMENT_COMPLETION_OWNER_ID,
			sessionRef,
			generation,
		);
		const cancellation: CancelSessionOperationRequest = {
			operation,
			ref: sessionRef,
			runtimeId,
			generation,
		};
		let requestPending = false;
		const timer = window.setTimeout(() => {
			requestPending = true;
			void hostSessionApi
				.listCommandArgumentCompletions({
					...cancellation,
					deadlineAt: Date.now() + COMPLETION_REQUEST_DEADLINE_MS,
					...commandArgumentRequest,
				})
				.then((result) => {
					requestPending = false;
					if (commandArgumentRequestSequence.current !== requestSequence) return;
					const suggestions = result;
					setCommandArgumentCompletions(
						suggestions && suggestions.items.length > 0
							? bindSessionRuntimeInputValue(
									{
										identity: { refKey: draftKey, runtimeId, generation },
										inputRevision,
										text,
										cursorOffset,
									},
									suggestions,
								)
							: null,
					);
				})
				.catch((cause: unknown) => {
					requestPending = false;
					if (commandArgumentRequestSequence.current !== requestSequence) return;
					setCommandArgumentCompletions(null);
					if (!isExpectedCancellation(cause)) onCommandError(formatRequestError(cause));
				});
		}, COMPLETION_DEBOUNCE_MS);
		return () => {
			commandArgumentRequestSequence.current += 1;
			window.clearTimeout(timer);
			if (!requestPending) return;
			void hostSessionApi
				.cancelRequest(cancellation)
				.catch((cause: unknown) => onCommandError(formatRequestError(cause)));
		};
	}, [
		hostSessionApi,
		draftKey,
		sessionRef,
		commandArgumentRequest,
		cursorOffset,
		onCommandError,
		runtimeBinding.generation,
		runtimeBinding.runtimeId,
		text,
		composerInputRevisionRef,
	]);
	const currentRuntimeIdentity = {
		refKey: draftKey,
		runtimeId: runtimeBinding.runtimeId,
		generation: runtimeBinding.generation,
	};
	const currentRuntimeIdentityRef = useRef(currentRuntimeIdentity);
	currentRuntimeIdentityRef.current = currentRuntimeIdentity;
	const currentRuntimeInput = {
		identity: currentRuntimeIdentity,
		inputRevision: composerInputRevisionRef.current,
		text,
		cursorOffset,
	};
	const activeExtensionAutocomplete = currentSessionRuntimeInputBoundValue(
		extensionAutocompleteState,
		currentRuntimeInput,
	);
	const activeCommandArgumentCompletions = currentSessionRuntimeInputBoundValue(
		commandArgumentCompletionsState,
		currentRuntimeInput,
	);
	const extensionAutocomplete = activeExtensionAutocomplete?.value ?? null;
	const commandArgumentCompletions = activeCommandArgumentCompletions?.value ?? null;
	const extensionAutocompleteItems =
		extensionAutocomplete?.items.map((item, index) => ({
			kind: "suggestion" as const,
			name: `autocomplete:${index}:${item.label}`,
			displayText: item.label,
			description: item.description ?? item.value,
			item,
		})) ?? [];
	const commandArgumentCompletionItems =
		commandArgumentCompletions?.items.map((item, index) => ({
			kind: "argument" as const,
			name: `argument:${index}:${item.label}`,
			displayText: item.label,
			description: item.description ?? item.value,
			item,
		})) ?? [];
	const applyExtensionCompletion = (index: number) => {
		const input = editorRef.current?.read();
		const activeText = input?.text ?? composerTextRef.current;
		const activeCursorOffset = input?.cursorOffset ?? composerCursorOffsetRef.current;
		// A native caret move can reach the editor before React has rendered the new cursor state.
		// Rebind the suggestion to the live input before IPC so a stale prefix never reaches Pi's
		// strict applyCompletion boundary.
		const liveAutocomplete = currentSessionRuntimeInputBoundValue(extensionAutocompleteState, {
			identity: currentRuntimeIdentityRef.current,
			inputRevision: composerInputRevisionRef.current,
			text: activeText,
			cursorOffset: activeCursorOffset,
		});
		if (!liveAutocomplete) {
			setExtensionAutocomplete(null);
			return;
		}
		const item = liveAutocomplete.value.items[index];
		if (!item) return;
		const prefix = liveAutocomplete.value.prefix;
		const prefixStart = activeCursorOffset - prefix.length;
		if (prefixStart < 0 || activeText.slice(prefixStart, activeCursorOffset) !== prefix) {
			setExtensionAutocomplete(null);
			return;
		}
		// The sequence is bumped only when a request is actually issued: an early bail-out above
		// must not invalidate an apply that is already in flight.
		const request = {
			sequence: ++autocompleteApplySequence.current,
			inputRevision: composerInputRevisionRef.current,
			identity: liveAutocomplete.identity,
			text: activeText,
			cursorOffset: activeCursorOffset,
		};
		void hostSessionApi
			.applyExtensionAutocomplete({
				ref: sessionRef,
				runtimeId: liveAutocomplete.identity.runtimeId,
				generation: liveAutocomplete.identity.generation,
				text: activeText,
				cursorOffset: activeCursorOffset,
				item,
				prefix,
			})
			.then((result) => {
				const input = editorRef.current?.read();
				if (
					!canApplyExtensionAutocompleteResult(request, {
						sequence: autocompleteApplySequence.current,
						inputRevision: composerInputRevisionRef.current,
						identity: currentRuntimeIdentityRef.current,
						text: input?.text ?? composerTextRef.current,
						cursorOffset: input?.cursorOffset ?? composerCursorOffsetRef.current,
					})
				) {
					return;
				}
				if (!setText(result.text)) return;
				setCursorOffset(result.cursorOffset);
				setExtensionAutocomplete(null);
				const applied = {
					...request,
					inputRevision: composerInputRevisionRef.current,
					text: result.text,
					cursorOffset: result.cursorOffset,
				};
				scheduleFocus(() => {
					if (
						!canApplyExtensionAutocompleteResult(applied, {
							sequence: autocompleteApplySequence.current,
							inputRevision: composerInputRevisionRef.current,
							identity: currentRuntimeIdentityRef.current,
							text: editorRef.current?.read().text ?? composerTextRef.current,
							cursorOffset: composerCursorOffsetRef.current,
						})
					) {
						return;
					}
					editorRef.current?.focus(result.cursorOffset);
				});
			})
			.catch((cause: unknown) => {
				const input = editorRef.current?.read();
				if (
					canApplyExtensionAutocompleteResult(request, {
						sequence: autocompleteApplySequence.current,
						inputRevision: composerInputRevisionRef.current,
						identity: currentRuntimeIdentityRef.current,
						text: input?.text ?? composerTextRef.current,
						cursorOffset: input?.cursorOffset ?? composerCursorOffsetRef.current,
					})
				) {
					if (!isExpectedCancellation(cause)) onCommandError(formatRequestError(cause));
				}
			});
	};

	const applyCommandArgumentCompletion = (index: number) => {
		if (!activeCommandArgumentCompletions) return;
		const entry = commandArgumentCompletionItems[index];
		if (!entry) return;
		const activeCursorOffset = editorRef.current?.read().cursorOffset ?? cursorOffset;
		const prefix = activeCommandArgumentCompletions.value.prefix;
		const prefixStart = activeCursorOffset - prefix.length;
		if (prefixStart < 0 || text.slice(prefixStart, activeCursorOffset) !== prefix) {
			setCommandArgumentCompletions(null);
			onCommandError("Command completion no longer matches the current text");
			return;
		}
		const beforePrefix = text.slice(0, prefixStart);
		const afterCursor = text.slice(activeCursorOffset);
		const nextText = `${beforePrefix}${entry.item.value}${afterCursor}`;
		const nextCursorOffset = beforePrefix.length + entry.item.value.length;
		setText(nextText);
		setCursorOffset(nextCursorOffset);
		setCommandArgumentCompletions(null);
		scheduleFocus(() => {
			editorRef.current?.focus(nextCursorOffset);
		});
	};

	const clearCompletions = () => {
		setExtensionAutocomplete(null);
		setCommandArgumentCompletions(null);
	};

	return {
		extensionAutocompleteItems,
		commandArgumentCompletionItems,
		applyExtensionCompletion,
		applyCommandArgumentCompletion,
		clearCompletions,
	};
}
