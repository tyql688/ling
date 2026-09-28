import { EditorOutline } from "@renderer/features/files/editor-outline";
import type { WorkspaceExplorerNavigation } from "@renderer/features/files/use-workspace-explorer";
import { WorkspaceExplorerPanel } from "@renderer/features/files/workspace-explorer-panel";
import { useReviewWorkspace } from "@renderer/features/review/use-review-workspace";
import { useCallback, useEffect, useMemo, type SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import { explorerRefreshRevisions } from "../files/explorer-revisions";
import { useReadingWorkspace } from "./reading-state";
import { useWorkspaceFileActions } from "./workspace-file-actions";
import {
	useWorkspaceField,
	useWorkspaceOwner,
	workspacePanelAtom,
	workspaceSelectionAtom,
	workspaceTabsAtom,
} from "./workspace-state";

/** The file tree docked beside the right column's content, with the active file's outline below it. */
export function WorkspaceFileTree() {
	const { t } = useTranslation();
	const activeSessionRef = useWorkspaceField(workspaceSelectionAtom, "activeSessionRef");
	const activeSessionKey = useWorkspaceField(workspaceSelectionAtom, "activeSessionKey");
	const activeProject = useWorkspaceField(workspaceSelectionAtom, "activeProject");
	const { handleInsertProjectFileReference } = useWorkspaceFileActions();
	const { activeViewer, openViewer } = useWorkspaceOwner(workspaceTabsAtom);
	const workbenchPanel = useWorkspaceOwner(workspacePanelAtom);
	const [reading, setReading] = useReadingWorkspace(activeSessionRef);
	const setExplorerNavigation = useCallback(
		(update: SetStateAction<WorkspaceExplorerNavigation>) =>
			setReading((current) => ({
				...current,
				explorer: typeof update === "function" ? update(current.explorer) : update,
			})),
		[setReading],
	);
	const activePath = activeViewer?.kind === "file" ? activeViewer.path : null;
	useEffect(() => {
		if (activePath === null) return;
		setExplorerNavigation((current) => {
			const expanded = new Set(current.expanded);
			const segments = activePath.split(/[/\\]/);
			for (let index = 1; index < segments.length; index++) expanded.add(segments.slice(0, index).join("/"));
			if (current.selectedPath === activePath && expanded.size === current.expanded.size) return current;
			return { ...current, selectedPath: activePath, expanded };
		});
	}, [activePath, setExplorerNavigation]);
	const { review: changeReview, files: changedFiles, refresh: refreshChanges } = useReviewWorkspace();
	const revisions = useMemo(
		() => explorerRefreshRevisions(changeReview.snapshot?.scopes.workspace.files ?? [], changedFiles.files),
		[changeReview.snapshot, changedFiles.files],
	);
	if (activeSessionRef === null || activeSessionKey === null) return null;
	return (
		<aside
			data-workspace-side-panel=""
			aria-label={t("explorer.title")}
			className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
		>
			<WorkspaceExplorerPanel
				key={activeSessionKey}
				navigation={reading.explorer}
				onNavigationChange={setExplorerNavigation}
				cwd={activeSessionRef.cwd}
				projectName={activeProject?.name}
				open
				changedFiles={changedFiles.files}
				treeRefreshRevision={revisions.tree}
				focusFile={workbenchPanel.explorerFocus}
				onFocusFileHandled={workbenchPanel.clearExplorerFocus}
				onInsertReference={handleInsertProjectFileReference}
				onRefreshWorkspace={refreshChanges}
				onOpenFile={openViewer}
			/>
			<EditorOutline viewKey={activeSessionKey} />
		</aside>
	);
}
