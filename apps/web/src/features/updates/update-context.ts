import type { UpdateEvent, UpdateState } from "@ling/contracts/update";
import { createContext, useContext } from "react";

export const UpdateContext = createContext<{
	state: UpdateState | null;
	phase: UpdateEvent | null;
	openUpdates(): void;
} | null>(null);

export function useUpdates() {
	const context = useContext(UpdateContext);
	if (!context) throw new Error("Updates require UpdateProvider");
	return context;
}
