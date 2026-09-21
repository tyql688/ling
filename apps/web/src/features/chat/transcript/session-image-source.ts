import type { SessionRef } from "@ling/contracts/session";
import { createContext, useContext } from "react";

/**
 * Attachment URLs stay bound to the transcript that owns them. Carrying its ref with
 * the subtree preserves that identity while active-session navigation changes.
 */
export const SessionImageRefContext = createContext<SessionRef | null>(null);

export function useSessionImageRef(): SessionRef | null {
	return useContext(SessionImageRefContext);
}
