import { createContext, useContext } from "react";

/** Session-scoped pages that open as reading tabs beside the conversation. */
export type FeaturePageId = "todo" | "questions" | "background-tasks";

export const featurePageTitleKeys: Record<FeaturePageId, string> = {
	todo: "todo.title",
	questions: "questions.title",
	"background-tasks": "backgroundTasks.title",
};

export const FeatureNavigationContext = createContext<((id: FeaturePageId) => void) | null>(null);

/** Feature views depend on this navigation port rather than the workspace composition. */
export function useFeatureNavigation() {
	const navigate = useContext(FeatureNavigationContext);
	if (navigate === null) throw new Error("Feature navigation is unavailable outside the workspace");
	return navigate;
}
