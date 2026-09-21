import type { ActiveSessionRuntimeIdentity, SessionRuntimeIdentity } from "../session-runtime-bound-value";

interface ExtensionAutocompleteApplySnapshot {
	sequence: number;
	inputRevision: number;
	identity: ActiveSessionRuntimeIdentity;
	text: string;
	cursorOffset: number;
}

interface CurrentExtensionAutocompleteInput {
	sequence: number;
	inputRevision: number;
	identity: SessionRuntimeIdentity;
	text: string;
	cursorOffset: number;
}

/** Applying a completion is a second asynchronous operation after suggestions
 * were read. Its result may update the draft only while both the runtime and
 * the exact composer input that initiated it remain current. */
export function canApplyExtensionAutocompleteResult(
	request: ExtensionAutocompleteApplySnapshot,
	current: CurrentExtensionAutocompleteInput,
): boolean {
	return (
		request.sequence === current.sequence &&
		request.inputRevision === current.inputRevision &&
		request.identity.refKey === current.identity.refKey &&
		request.identity.runtimeId === current.identity.runtimeId &&
		request.identity.generation === current.identity.generation &&
		request.text === current.text &&
		request.cursorOffset === current.cursorOffset
	);
}
