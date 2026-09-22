import type { ComposerMessage, ComposerMessagePreparation } from "../../sessions/state/composer-message";
import { submitMessageText } from "@renderer/features/sessions/state/message-text";
import { isShortcutModifier } from "@renderer/lib/platform";
import { useCallback, useRef, useState } from "react";
import type { SendShortcut } from "@renderer/lib/preferences/composer";

/** In-flight composer action; at most one at a time, with a revision so a stale completion can't clear a newer action. */
export type ComposerPendingAction = "send" | "save" | "stop" | null;

/** Draft access surface injected by the variant: session maps a draftsAtom slot, home maps local state. */
interface ComposerDraftAdapter<Snapshot> {
	text: string;
	attachmentCount: number;
	fileReferenceCount: number;
	/** Whether there is sendable content beyond text/attachments/references (pasted blocks, review comments). */
	hasExtraContent: boolean;
	/** Snapshot taken before submit; input for failure restore. */
	snapshot: () => Snapshot;
	/** Clears the draft before the submit is dispatched (including derived state like cursor/revision/limit feedback). */
	clear: () => void;
	/** Restores after a failed submit; whether to overwrite new user input is up to the adapter (usually only when the current draft is empty). */
	restore: (snapshot: Snapshot) => void;
}

interface ComposerCoreOptions<Snapshot, Payload> {
	preparing?: boolean;
	adapter: ComposerDraftAdapter<Snapshot>;
	/** Last gate before clearing the draft (e.g. the home target-project check); false aborts and leaves the draft untouched. */
	validate?: (() => boolean) | undefined;
	/** Builds all outgoing fields from the captured draft before any input is cleared. */
	prepare: (snapshot: Snapshot) => ComposerMessagePreparation;
	onLimitError: () => void;
	/** Preparation failures have no session request to report them; the input surface owns this feedback. */
	onPreparationError: (cause: unknown) => void;
	submit: (message: ComposerMessage, snapshot: Snapshot, payload: Payload) => Promise<void>;
	/** Callback after a submit is accepted; receives the original text at submit time (used by composer history). */
	onSubmitted?: ((submitted: string | null) => void) | undefined;
	/** Error outlet for failed submits (after restore); the session side already has a banner from the send pipeline, so it stays unset there. */
	onSubmitError?: ((cause: unknown) => void) | undefined;
}

export interface ComposerCore<Payload> {
	hasSendableContent: boolean;
	pendingAction: ComposerPendingAction;
	/** Acquires the action lock; returns null when another action is already in flight. */
	beginAction: (action: Exclude<ComposerPendingAction, null>) => number | null;
	/** Releases by revision; a mismatched revision (already invalidated) is ignored. */
	finishAction: (revision: number) => void;
	/** Invalidates all in-flight actions (session switch, busy transition releasing the lock). */
	invalidateActions: () => void;
	requestSubmit: (payload: Payload) => void;
}

export function useComposerCore<Snapshot, Payload = void>(
	options: ComposerCoreOptions<Snapshot, Payload>,
): ComposerCore<Payload> {
	const [pendingAction, setPendingAction] = useState<ComposerPendingAction>(null);
	const pendingRef = useRef<ComposerPendingAction>(null);
	const revisionRef = useRef(0);

	const beginAction = useCallback((action: Exclude<ComposerPendingAction, null>): number | null => {
		if (pendingRef.current !== null) return null;
		const revision = revisionRef.current + 1;
		revisionRef.current = revision;
		pendingRef.current = action;
		setPendingAction(action);
		return revision;
	}, []);

	const finishAction = useCallback((revision: number): void => {
		if (revisionRef.current !== revision) return;
		pendingRef.current = null;
		setPendingAction(null);
	}, []);

	const invalidateActions = useCallback((): void => {
		revisionRef.current += 1;
		pendingRef.current = null;
		setPendingAction(null);
	}, []);

	const { adapter } = options;
	const hasSendableContent =
		!options.preparing &&
		(submitMessageText(adapter.text) !== null ||
			adapter.attachmentCount > 0 ||
			adapter.fileReferenceCount > 0 ||
			adapter.hasExtraContent);

	const requestSubmit = (payload: Payload): void => {
		if (pendingRef.current !== null || !hasSendableContent) return;
		if (options.validate !== undefined && !options.validate()) return;
		const snapshot = adapter.snapshot();
		let prepared: ComposerMessagePreparation;
		try {
			prepared = options.prepare(snapshot);
		} catch (cause) {
			options.onPreparationError(cause);
			return;
		}
		if (prepared.status === "empty") return;
		if (prepared.status === "tooLong") {
			options.onLimitError();
			return;
		}
		const revision = beginAction("send");
		if (revision === null) return;
		adapter.clear();
		void Promise.resolve()
			.then(() => options.submit(prepared.message, snapshot, payload))
			.then(() => options.onSubmitted?.(prepared.message.submittedText))
			.catch((cause: unknown) => {
				adapter.restore(snapshot);
				options.onSubmitError?.(cause);
			})
			.finally(() => finishAction(revision));
	};

	return { hasSendableContent, pendingAction, beginAction, finishAction, invalidateActions, requestSubmit };
}

interface ComposerKeyboardOptions {
	isComposing: (event: globalThis.KeyboardEvent) => boolean;
	/** Send-shortcut preference (enter / cmd-enter-always / …), decides whether Enter sends. */
	sendShortcut: Parameters<typeof enterShouldSend>[0];
	text: string;
	/** Variant-level pre-interception (history navigation, completion popover); returning true means the event was consumed. */
	intercept?: ((event: globalThis.KeyboardEvent) => boolean) | undefined;
	/** Submit outlet after the Enter check passes; withShortcutModifier lets variants invert steer/followUp. */
	onSubmit: (withShortcutModifier: boolean) => void;
}

/** IME guard + Enter-send check; an Enter that doesn't send falls back to the default newline. */
export function useComposerKeyboard(options: ComposerKeyboardOptions): (event: globalThis.KeyboardEvent) => void {
	return (event) => {
		// During IME composition, Enter/Tab/arrow keys belong to the candidate list — never trigger send or popovers.
		if (options.isComposing(event)) return;
		if (options.intercept?.(event)) return;
		if (event.key !== "Enter" || event.shiftKey) return;
		const withShortcutModifier = isShortcutModifier(event);
		if (!enterShouldSend(options.sendShortcut, withShortcutModifier, options.text.includes("\n"))) return;
		event.preventDefault();
		options.onSubmit(withShortcutModifier);
	};
}

/**
 * "Send shortcut" semantics, shared by the session composer and the home screen:
 * - "enter":               Enter sends (shortcut modifier+Enter too); Shift+Enter inserts a newline
 * - "cmd-enter-multiline": Enter sends single-line drafts, but once the draft spans
 *                          multiple lines Enter inserts a newline and shortcut modifier+Enter sends
 * - "cmd-enter-always":    Enter always inserts a newline; only shortcut modifier+Enter sends
 */
function enterShouldSend(shortcut: SendShortcut, withCmd: boolean, draftIsMultiline: boolean): boolean {
	switch (shortcut) {
		case "cmd-enter-always":
			return withCmd;
		case "cmd-enter-multiline":
			return withCmd || !draftIsMultiline;
		case "enter":
			return true;
	}
}
