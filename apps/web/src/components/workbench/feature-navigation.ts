import {
	Activity,
	Blocks,
	FileCog,
	FolderOpen,
	GitCompareArrows,
	GraduationCap,
	LayoutGrid,
	ListTodo,
	MessageCircleQuestion,
	SquareTerminal,
	type LucideIcon,
} from "lucide-react";
import { createContext, useContext } from "react";

/** Session-scoped tools and pages; each opens as one tab in the right column. */
export type FeaturePageId =
	| "files"
	| "changes"
	| "terminal"
	| "skills"
	| "pi-config"
	| "dock"
	| "todo"
	| "questions"
	| "background-tasks"
	| "new-tab";

export const featurePageTitleKeys: Record<FeaturePageId, string> = {
	files: "explorer.selectFileTitle",
	changes: "changes.toolbarLabel",
	terminal: "terminal.title",
	skills: "skills.title",
	"pi-config": "projectPiConfig.toolbarLabel",
	dock: "extensionUi.dockTitle",
	todo: "todo.title",
	questions: "questions.title",
	"background-tasks": "backgroundTasks.title",
	"new-tab": "reading.newTab",
};

export const featurePageIcons: Record<FeaturePageId, LucideIcon> = {
	files: FolderOpen,
	changes: GitCompareArrows,
	terminal: SquareTerminal,
	skills: GraduationCap,
	"pi-config": FileCog,
	dock: Blocks,
	todo: ListTodo,
	questions: MessageCircleQuestion,
	"background-tasks": Activity,
	"new-tab": LayoutGrid,
};

/** Badge ceiling: bound narrow tabs and menus so large counts do not displace their labels. */
const MAX_VISIBLE_COUNT = 99;

export function formatFeatureCount(count: number): string {
	return count > MAX_VISIBLE_COUNT ? `${MAX_VISIBLE_COUNT}+` : count.toString();
}

export const FeatureNavigationContext = createContext<((id: FeaturePageId) => void) | null>(null);

/** Opens feature pages through shared navigation callbacks. */
export function useFeatureNavigation() {
	const navigate = useContext(FeatureNavigationContext);
	if (navigate === null) throw new Error("Feature navigation is unavailable outside the workspace");
	return navigate;
}
