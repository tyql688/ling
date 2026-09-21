import { useDomainApi } from "@renderer/lib/host-api-context";
import type { SessionRef } from "@ling/contracts/session-ref";
import { formatRequestError, isExpectedCompanionRace } from "@renderer/lib/errors";
import { useEffect } from "react";

/** Mirror text only while the originating session runtime and input are current. */
export function useComposerEditorMirror(
	ref: SessionRef,
	{ runtimeId, generation }: { runtimeId: string | null; generation: number },
	text: string,
	onError: (message: string) => void,
): void {
	const hostSessionApi = useDomainApi("session");

	useEffect(() => {
		if (runtimeId === null) return;
		let current = true;
		// Pi's editor mirror does not need one transport request per keystroke.
		const timer = window.setTimeout(() => {
			void hostSessionApi.setExtensionUiEditorText({ ref, runtimeId, generation, text }).catch((cause: unknown) => {
				if (current && !isExpectedCompanionRace(cause)) onError(formatRequestError(cause));
			});
		}, 120);
		return () => {
			current = false;
			window.clearTimeout(timer);
		};
	}, [hostSessionApi, ref, runtimeId, generation, text, onError]);
}
