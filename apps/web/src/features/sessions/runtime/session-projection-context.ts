import type { SessionRef } from "@ling/contracts/session-ref";
import { createContext, useContext } from "react";

export const SessionProjectionContext = createContext<((ref: SessionRef) => void) | null>(null);

/** The renderer creates its projection owner before mounting any conversation surface. */
export function useSessionProjectionRefresh(): (ref: SessionRef) => void {
	const refresh = useContext(SessionProjectionContext);
	if (refresh === null) throw new Error("Session projection runtime is not available");
	return refresh;
}
