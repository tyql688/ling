import type { LingApi } from "@ling/contracts/api/ling-api";
import { createContext, useContext } from "react";

/** Bootstrap supplies one immutable client for this renderer's lifetime. Owners request their domain explicitly. */
export const HostApiContext = createContext<LingApi | null>(null);

export function useDomainApi<Domain extends keyof LingApi>(domain: Domain): LingApi[Domain] {
	const api = useContext(HostApiContext);
	if (api === null) throw new Error("Host API has not been bound to the renderer");
	return api[domain];
}
