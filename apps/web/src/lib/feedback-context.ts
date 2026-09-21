import { createContext, type ReactNode, useContext } from "react";

export type FeedbackTone = "info" | "success" | "warning" | "danger";

export interface AppFeedbackInput {
	tone: FeedbackTone;
	title: string;
	description?: ReactNode;
	/** Replaces older feedback for the same operation instead of stacking duplicates. */
	dedupeKey?: string;
	/** Success/info default to 3 seconds; warning/danger remain until dismissed. */
	durationMs?: number | null;
}

export interface AppFeedbackContextValue {
	show: (input: AppFeedbackInput) => string;
	dismiss: (id: string) => void;
}

export const AppFeedbackContext = createContext<AppFeedbackContextValue | null>(null);

export function useAppFeedback(): AppFeedbackContextValue {
	const context = useContext(AppFeedbackContext);
	if (context === null) throw new Error("useAppFeedback must be used inside AppFeedbackProvider");
	return context;
}
