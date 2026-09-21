import { useCommandFeedback } from "@renderer/hooks/use-command-feedback";
import type { ReactNode } from "react";
import { TerminalContext, useTerminalController } from "./use-terminal-controller";
/** PTYs and emulators stay owned by the workspace across session and view changes. */
export function TerminalProvider({ children }: { children: ReactNode }) {
	const onError = useCommandFeedback();
	const controller = useTerminalController(onError);
	return <TerminalContext.Provider value={controller}>{children}</TerminalContext.Provider>;
}
