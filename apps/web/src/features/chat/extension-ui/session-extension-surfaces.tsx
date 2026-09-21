import { type SessionRef, sessionKey } from "@ling/contracts/session-ref";
import { EMPTY_EXTENSION_UI_STATE } from "@ling/contracts/session";
import { PanelBoundary } from "@renderer/components/error-fallback";
import { extensionUiSnapshotFamily } from "@renderer/features/sessions/state/session";
import { useCommandFeedback } from "@renderer/hooks/use-command-feedback";
import { useAtomValue } from "jotai";
import { ExtensionDock } from "./extension-dock";
import { ExtensionCustomPanel } from "./extension-ui-surface";
import { useExtensionEditorDraft } from "./use-extension-editor-draft";

export function SessionExtensionEditor({ sessionRef }: { sessionRef: SessionRef | null }) {
	const snapshot = useAtomValue(extensionUiSnapshotFamily(sessionRef ? sessionKey(sessionRef) : ""));
	useExtensionEditorDraft(sessionRef, (snapshot?.state ?? EMPTY_EXTENSION_UI_STATE).editorText);
	return null;
}

export function SessionExtensionDock({ sessionRef, onClose }: { sessionRef: SessionRef; onClose(): void }) {
	const snapshot = useAtomValue(extensionUiSnapshotFamily(sessionKey(sessionRef)));
	const onError = useCommandFeedback();
	return (
		<ExtensionDock
			docked
			state={snapshot?.state ?? EMPTY_EXTENSION_UI_STATE}
			open
			onClose={onClose}
			onOpenLinkError={onError}
		/>
	);
}

export function SessionExtensionOverlay({ sessionRef }: { sessionRef: SessionRef | null }) {
	const key = sessionRef ? sessionKey(sessionRef) : "";
	const snapshot = useAtomValue(extensionUiSnapshotFamily(key));
	const state = snapshot?.state ?? EMPTY_EXTENSION_UI_STATE;
	const onError = useCommandFeedback();
	return (
		sessionRef && (
			<PanelBoundary resetKeys={[key, state.customPanel]}>
				<ExtensionCustomPanel sessionRef={sessionRef} panel={state.customPanel} onError={onError} />
			</PanelBoundary>
		)
	);
}
