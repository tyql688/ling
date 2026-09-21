import type { GitChangedFile } from "@ling/contracts/git";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { LoadingTransition } from "@renderer/components/ui/loading-transition";
import { TooltipIconButton } from "@renderer/components/ui/tooltip-icon-button";
import type { InsertFileReferenceOptions } from "@renderer/features/sessions/state/composer-file-references";
import { useCommandFeedback } from "@renderer/hooks/use-command-feedback";
import { useDomainApi } from "@renderer/lib/host-api-context";
import { cn } from "@renderer/lib/utils";
import { ChevronsDownUp, FolderX, RefreshCw, Search, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, type Dispatch, type SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import { useWorkspaceExplorer, type WorkspaceExplorerNavigation } from "./use-workspace-explorer";
import { WorkspaceExplorerTree } from "./workspace-explorer-tree";

/** The tree navigates the reading area. Navigation belongs to its session, filesystem requests to the project. */
export function WorkspaceExplorerPanel({
	cwd,
	projectName,
	open,
	changedFiles,
	treeRefreshRevision,
	focusFile,
	onFocusFileHandled,
	onInsertReference,
	onRefreshWorkspace,
	onOpenFile,
	navigation,
	onNavigationChange,
}: {
	cwd: string;
	projectName?: string | undefined;
	open: boolean;
	changedFiles: readonly GitChangedFile[];
	treeRefreshRevision: string;
	focusFile: { path: string; directory: boolean } | null;
	onFocusFileHandled(): void;
	onInsertReference(path: string, options?: InsertFileReferenceOptions): void;
	onRefreshWorkspace(): void;
	onOpenFile(path: string, keepOpen?: boolean): void;
	navigation: WorkspaceExplorerNavigation;
	onNavigationChange: Dispatch<SetStateAction<WorkspaceExplorerNavigation>>;
}) {
	const { t } = useTranslation();
	const projectApi = useDomainApi("project");
	const uiApi = useDomainApi("ui");
	const onError = useCommandFeedback();
	const setExpanded = useCallback(
		(update: SetStateAction<ReadonlySet<string>>) =>
			onNavigationChange((current) => ({
				...current,
				expanded: typeof update === "function" ? update(current.expanded) : update,
			})),
		[onNavigationChange],
	);
	const explorer = useWorkspaceExplorer(cwd, open, navigation.expanded, setExpanded);
	const { refresh, expandDirectory } = explorer;
	const previousRevision = useRef(treeRefreshRevision);
	useEffect(() => {
		if (!open || previousRevision.current === treeRefreshRevision) return;
		previousRevision.current = treeRefreshRevision;
		refresh();
	}, [open, refresh, treeRefreshRevision]);
	const selectFile = useCallback(
		(path: string, keepOpen = false) => {
			onNavigationChange((current) => ({ ...current, selectedPath: path }));
			onOpenFile(path, keepOpen);
		},
		[onNavigationChange, onOpenFile],
	);
	useEffect(() => {
		if (!open || focusFile === null) return;
		const segments = focusFile.path.split(/[/\\]/);
		for (let i = 1; i <= (focusFile.directory ? segments.length : segments.length - 1); i++)
			expandDirectory(segments.slice(0, i).join("/"));
		if (!focusFile.directory) selectFile(focusFile.path);
		onFocusFileHandled();
	}, [expandDirectory, focusFile, onFocusFileHandled, open, selectFile]);
	const rows = useMemo(() => {
		const query = navigation.query.trim().toLocaleLowerCase();
		if (!query) return explorer.rows;
		const visible = new Set<string>();
		for (const row of explorer.rows) {
			if (row.kind !== "entry" || !row.entry.path.toLocaleLowerCase().includes(query)) continue;
			let path = row.entry.path;
			while (path.length > 0 && !visible.has(path)) {
				visible.add(path);
				const separator = path.lastIndexOf("/");
				if (separator < 0) break;
				path = path.slice(0, separator);
			}
		}
		return explorer.rows.filter((row) => row.kind === "entry" && visible.has(row.entry.path));
	}, [explorer.rows, navigation.query]);
	const saveScroll = useCallback(
		(scrollTop: number) =>
			onNavigationChange((current) => (current.scrollTop === scrollTop ? current : { ...current, scrollTop })),
		[onNavigationChange],
	);
	const copyPath = (path: string) => {
		void navigator.clipboard.writeText(path).catch(onError);
	};
	const revealEntry = uiApi.capabilities.nativePathReveal
		? (path: string) => {
				void projectApi.revealEntry({ cwd, path }).catch(onError);
			}
		: undefined;
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex shrink-0 items-center gap-1 px-3 py-2 text-xs text-text-muted">
				<span className="min-w-0 flex-1 truncate" title={cwd}>
					{projectName ?? cwd}
				</span>
				<TooltipIconButton
					label={t("explorer.collapseAll")}
					onClick={explorer.collapseAll}
					disabled={explorer.expanded.size === 0}
				>
					<ChevronsDownUp className="size-3.5" />
				</TooltipIconButton>
				<TooltipIconButton
					label={t("explorer.refresh")}
					onClick={() => {
						refresh();
						onRefreshWorkspace();
					}}
				>
					<RefreshCw className={cn("size-3.5", explorer.root.loading && "animate-spin motion-reduce:animate-none")} />
				</TooltipIconButton>
			</div>
			<div className="relative mx-3 mb-2 shrink-0">
				<Search className="pointer-events-none absolute left-2.5 top-2 size-3.5 text-text-muted" />
				<Input
					aria-label={t("reading.filterFiles")}
					placeholder={t("reading.filterFiles")}
					value={navigation.query}
					onChange={(event) => onNavigationChange((current) => ({ ...current, query: event.target.value }))}
					className="h-8 pl-8 text-xs shadow-none"
				/>
			</div>
			{explorer.root.error !== null && !explorer.root.directoryMissing && (
				<div role="alert" className="mx-3 mb-2 rounded-control border border-danger/20 p-2 text-xs text-danger">
					<TriangleAlert className="mr-1 inline size-3.5" />
					{explorer.root.error}
					<Button variant="ghost" size="sm" onClick={refresh}>
						{t("explorer.retry")}
					</Button>
				</div>
			)}
			{explorer.root.directoryMissing ? (
				// The folder is gone, not unreadable. Keep presenting it as this project's folder
				// instead of a failed request: a retry cannot succeed until the folder is back, and
				// the header's refresh already covers that.
				<div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
					<FolderX className="size-6 text-text-muted" aria-hidden="true" />
					<span className="text-xs text-text-muted">{t("project.directoryMissingDetail")}</span>
				</div>
			) : !explorer.root.loaded ? (
				explorer.root.loading ? (
					<LoadingTransition label={t("explorer.loadingFolder")} className="min-h-40 flex-1" />
				) : null
			) : rows.length === 0 ? (
				<div className="p-4 text-xs text-text-muted">
					{t(navigation.query ? "reading.noFiles" : "explorer.emptyProjectTitle")}
				</div>
			) : (
				<WorkspaceExplorerTree
					rows={rows}
					directories={explorer.directories}
					expanded={explorer.expanded}
					selectedPath={navigation.selectedPath}
					changedFiles={changedFiles}
					initialScrollTop={navigation.scrollTop}
					onScrollTopChange={saveScroll}
					onToggleDirectory={explorer.toggleDirectory}
					onExpandDirectory={expandDirectory}
					onCollapseDirectory={explorer.collapseDirectory}
					onSelectFile={selectFile}
					onRetryDirectory={explorer.retryDirectory}
					onCopyPath={copyPath}
					onInsertReference={onInsertReference}
					onRevealEntry={revealEntry}
				/>
			)}
		</div>
	);
}
