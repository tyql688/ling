import { createContext, useContext } from "react";

interface WorkbenchLayout {
	floating: boolean;
	compact: boolean;
	hasReading: boolean;
	hasRightColumn: boolean;
	sideVisible: boolean;
	setComposerHeight: (height: number) => void;
	toggleSidePanel: () => void;
}
export const WorkbenchLayoutContext = createContext<WorkbenchLayout | null>(null);
export function useWorkbenchLayout(): WorkbenchLayout {
	const layout = useContext(WorkbenchLayoutContext);
	if (!layout) throw new Error("Workbench layout is not mounted");
	return layout;
}
