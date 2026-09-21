import type { Interaction, InteractionAnswer } from "@ling/contracts/companions";
import { createContext, useContext } from "react";

type Draft = InteractionAnswer["answers"];

interface InteractionsState {
	requests: Interaction[];
	error: string | null;
	drafts: Record<string, Draft>;
	updateDraft(id: string, value: Draft): void;
	clearDraft(id: string): void;
	setInlineRequests(owner: string, ids: string[]): void;
}
export const InteractionsContext = createContext<InteractionsState>({
	requests: [],
	error: null,
	drafts: {},
	updateDraft() {
		throw new Error("Interaction provider is unavailable");
	},
	clearDraft() {},
	setInlineRequests() {},
});
export const useInteractions = () => useContext(InteractionsContext);
