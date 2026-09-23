import { type SessionRef, sessionKey } from "@ling/contracts/session-ref";
import { EMPTY_EXTENSION_UI_STATE } from "@ling/contracts/session";
import { extensionUiSnapshotFamily } from "@renderer/features/sessions/state/session";
import { useAtomValue } from "jotai";
import { selectAtom } from "jotai/vanilla/utils";
import { useMemo } from "react";
import { countExtensionDockItems } from "./extension-dock-count";

/** Shell chrome only subscribes to metadata; streamed extension contents stay inside their surface. */
export function useSessionExtensionMeta(sessionRef: SessionRef | null) {
	const key = sessionRef ? sessionKey(sessionRef) : "";
	const selected = useMemo(
		() =>
			selectAtom(
				extensionUiSnapshotFamily(key),
				(snapshot) => {
					const state = snapshot?.state ?? EMPTY_EXTENSION_UI_STATE;
					return {
						title: state.title,
						dockItems: countExtensionDockItems(state),
						terminalInputListening: state.terminalInputListening,
					};
				},
				(a, b) =>
					a.title === b.title && a.dockItems === b.dockItems && a.terminalInputListening === b.terminalInputListening,
			),
		[key],
	);
	return useAtomValue(selected);
}
