import type { GitChangedFile } from "@ling/contracts/git";
import type { ProjectDirectoryEntry } from "@ling/contracts/project";
import { MaterialFileIcon } from "@renderer/components/material-code-icon";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "@renderer/components/ui/context-menu";
import { LoadingTransition } from "@renderer/components/ui/loading-transition";
import type { InsertFileReferenceOptions } from "@renderer/features/sessions/state/composer-file-references";
import { cn } from "@renderer/lib/utils";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
	AtSign,
	ChevronRight,
	Copy,
	FileWarning,
	Folder,
	FolderOpen,
	FolderSearch,
	Link2,
	RotateCcw,
} from "lucide-react";
import {
	type KeyboardEvent as ReactKeyboardEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import type { WorkspaceDirectoryState, WorkspaceExplorerRow } from "./use-workspace-explorer";
import { gitStatusClass, gitStatusLabel } from "./workspace-explorer-format";

/** Keyboard typeahead buffer reset interval; 700ms after the last key, the next character starts a new search. */
const TYPEAHEAD_RESET_MS = 700;
/** Virtual list fixed row height (px); matches the tree row CSS height. */
const TREE_ROW_HEIGHT = 28;
/** Rows pre-rendered outside the viewport; reduces blank flicker during fast scrolls. */
const TREE_OVERSCAN_ROWS = 12;

interface WorkspaceExplorerTreeProps {
	initialScrollTop?: number;
	onScrollTopChange?: (scrollTop: number) => void;
	rows: readonly WorkspaceExplorerRow[];
	directories: ReadonlyMap<string, WorkspaceDirectoryState>;
	expanded: ReadonlySet<string>;
	selectedPath: string | null;
	changedFiles: readonly GitChangedFile[];
	onToggleDirectory: (path: string) => void;
	onExpandDirectory: (path: string) => void;
	onCollapseDirectory: (path: string) => void;
	onSelectFile: (path: string, keepOpen?: boolean) => void;
	onRetryDirectory: (path: string) => void;
	onCopyPath: (path: string) => void;
	onInsertReference: (path: string, options?: InsertFileReferenceOptions) => void;
	onRevealEntry: ((path: string) => void) | undefined;
}

function parentDirectories(path: string): string[] {
	const parents: string[] = [];
	let index = path.lastIndexOf("/");
	while (index >= 0) {
		const parent = path.slice(0, index);
		if (parent.length > 0) parents.push(parent);
		index = parent.lastIndexOf("/");
	}
	return parents;
}

function useGitTreeProjection(changedFiles: readonly GitChangedFile[]) {
	return useMemo(() => {
		const statusByPath = new Map(changedFiles.map((file) => [file.path, file.status]));
		const changesByDirectory = new Map<string, number>();
		for (const file of changedFiles) {
			for (const directory of parentDirectories(file.path)) {
				changesByDirectory.set(directory, (changesByDirectory.get(directory) ?? 0) + 1);
			}
		}
		return { statusByPath, changesByDirectory };
	}, [changedFiles]);
}

function entryRows(rows: readonly WorkspaceExplorerRow[]) {
	return rows.filter((row): row is Extract<WorkspaceExplorerRow, { kind: "entry" }> => row.kind === "entry");
}

function explorerRowKey(row: WorkspaceExplorerRow): string {
	return row.kind === "entry" ? `entry:${row.entry.path}` : `${row.kind}:${row.directoryPath}`;
}

function TreeMessageRow({
	row,
	onRetryDirectory,
}: {
	row: Exclude<WorkspaceExplorerRow, { kind: "entry" }>;
	onRetryDirectory: (path: string) => void;
}) {
	const { t } = useTranslation();
	return (
		<div
			role="presentation"
			style={{ paddingLeft: `${12 + row.depth * 16}px` }}
			className={cn(
				"flex min-h-7 items-center gap-1.5 pr-2 text-xs text-text-muted",
				row.kind === "error" && "py-1 text-danger",
			)}
		>
			{row.kind === "loading" ? (
				<LoadingTransition label={t("explorer.loadingFolder")} size="xs" className="min-h-7 w-4 justify-start" />
			) : row.kind === "error" ? (
				<>
					<FileWarning className="size-3.5 shrink-0" aria-hidden="true" />
					<span className="min-w-0 flex-1 truncate" title={row.message}>
						{t("explorer.folderUnavailable")}
					</span>
					<button
						type="button"
						onClick={() => onRetryDirectory(row.directoryPath)}
						className="flex size-6 shrink-0 items-center justify-center rounded-control text-text-muted hover:bg-surface-hover hover:text-text-primary"
						aria-label={t("explorer.retry")}
					>
						<RotateCcw className="size-3" aria-hidden="true" />
					</button>
				</>
			) : row.kind === "empty" ? (
				<span className="italic text-text-muted/70">{t("explorer.emptyFolder")}</span>
			) : (
				<span className="text-warning">{t("explorer.truncatedFolder")}</span>
			)}
		</div>
	);
}

function EntryContextMenu({
	entry,
	children,
	onCopyPath,
	onInsertReference,
	onRevealEntry,
}: {
	entry: ProjectDirectoryEntry;
	children: ReactNode;
	onCopyPath: (path: string) => void;
	onInsertReference: (path: string, options?: InsertFileReferenceOptions) => void;
	onRevealEntry: ((path: string) => void) | undefined;
}) {
	const { t } = useTranslation();
	return (
		<ContextMenu>
			<ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
			<ContextMenuContent className="w-52">
				{(entry.kind === "file" || entry.kind === "directory") && (
					<>
						<ContextMenuItem
							onSelect={() =>
								onInsertReference(entry.path, entry.kind === "directory" ? { directory: true } : undefined)
							}
						>
							<AtSign aria-hidden="true" />
							{t("explorer.addToChat")}
						</ContextMenuItem>
						<ContextMenuSeparator />
					</>
				)}
				<ContextMenuItem onSelect={() => onCopyPath(entry.path)}>
					<Copy aria-hidden="true" />
					{t("explorer.copyPath")}
				</ContextMenuItem>
				{entry.kind !== "unavailable" && onRevealEntry && (
					<ContextMenuItem onSelect={() => onRevealEntry(entry.path)}>
						<FolderSearch aria-hidden="true" />
						{t("explorer.reveal")}
					</ContextMenuItem>
				)}
			</ContextMenuContent>
		</ContextMenu>
	);
}

export function WorkspaceExplorerTree({
	initialScrollTop = 0,
	onScrollTopChange,
	rows,
	directories,
	expanded,
	selectedPath,
	changedFiles,
	onToggleDirectory,
	onExpandDirectory,
	onCollapseDirectory,
	onSelectFile,
	onRetryDirectory,
	onCopyPath,
	onInsertReference,
	onRevealEntry,
}: WorkspaceExplorerTreeProps) {
	const { t } = useTranslation();
	const entries = useMemo(() => entryRows(rows), [rows]);
	const { statusByPath, changesByDirectory } = useGitTreeProjection(changedFiles);
	const scrollRef = useRef<HTMLDivElement>(null);
	const initialOffset = useRef(initialScrollTop);
	const restorationPending = useRef(true);
	useEffect(() => {
		const scroll = scrollRef.current;
		if (!scroll) return;
		let top = initialOffset.current;
		const remember = () => {
			top = scroll.scrollTop;
		};
		scroll.addEventListener("scroll", remember);
		return () => {
			scroll.removeEventListener("scroll", remember);
			onScrollTopChange?.(top);
		};
	}, [onScrollTopChange]);
	useEffect(() => {
		const scroll = scrollRef.current;
		if (!scroll || !restorationPending.current) return;
		scroll.scrollTop = initialOffset.current;
		if (scroll.scrollTop >= initialOffset.current || !rows.some((row) => row.kind === "loading"))
			restorationPending.current = false;
	}, [rows]);
	const rowRefs = useRef(new Map<string, HTMLButtonElement>());
	const focusFramesRef = useRef<{ outer: number | null; inner: number | null }>({ outer: null, inner: null });
	const cancelDeferredFocus = useCallback((): void => {
		const frames = focusFramesRef.current;
		if (frames.outer !== null) window.cancelAnimationFrame(frames.outer);
		if (frames.inner !== null) window.cancelAnimationFrame(frames.inner);
		frames.outer = null;
		frames.inner = null;
	}, []);
	const typeaheadRef = useRef({ query: "", updatedAt: 0 });
	const [activePath, setActivePath] = useState<string | null>(null);
	const entryIndexByPath = useMemo(() => new Map(entries.map((row, index) => [row.entry.path, index])), [entries]);
	const rowIndexByPath = useMemo(() => {
		const indexes = new Map<string, number>();
		rows.forEach((row, index) => {
			if (row.kind === "entry") indexes.set(row.entry.path, index);
		});
		return indexes;
	}, [rows]);
	const getItemKey = useCallback(
		(index: number) => {
			const row = rows[index];
			return row === undefined ? index : explorerRowKey(row);
		},
		[rows],
	);
	const virtualizer = useVirtualizer({
		initialOffset: initialOffset.current,
		count: rows.length,
		getScrollElement: () => scrollRef.current,
		estimateSize: (index) => (rows[index]?.kind === "error" ? 36 : TREE_ROW_HEIGHT),
		getItemKey,
		overscan: TREE_OVERSCAN_ROWS,
	});

	useEffect(() => {
		setActivePath((current) =>
			current !== null && entryIndexByPath.has(current)
				? current
				: selectedPath !== null && entryIndexByPath.has(selectedPath)
					? selectedPath
					: (entries[0]?.entry.path ?? null),
		);
	}, [entries, entryIndexByPath, selectedPath]);

	const focusPath = useCallback(
		(path: string): void => {
			cancelDeferredFocus();
			setActivePath(path);
			const rowIndex = rowIndexByPath.get(path);
			if (rowIndex === undefined) return;
			virtualizer.scrollToIndex(rowIndex, { align: "auto" });
			focusFramesRef.current.outer = window.requestAnimationFrame(() => {
				focusFramesRef.current.outer = null;
				focusFramesRef.current.inner = window.requestAnimationFrame(() => {
					focusFramesRef.current.inner = null;
					rowRefs.current.get(path)?.focus({ preventScroll: true });
				});
			});
		},
		[cancelDeferredFocus, rowIndexByPath, virtualizer],
	);

	useEffect(() => cancelDeferredFocus, [cancelDeferredFocus]);

	const activateEntry = (entry: ProjectDirectoryEntry, keepOpen = false): void => {
		if (entry.kind === "directory") onToggleDirectory(entry.path);
		else if (entry.kind === "file") onSelectFile(entry.path, keepOpen);
	};

	const handleEntryKeyDown = (
		event: ReactKeyboardEvent<HTMLButtonElement>,
		entry: ProjectDirectoryEntry,
		parentPath: string,
	): void => {
		const index = entryIndexByPath.get(entry.path);
		if (index === undefined) return;
		if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
			event.preventDefault();
			const nextIndex =
				event.key === "Home"
					? 0
					: event.key === "End"
						? entries.length - 1
						: event.key === "ArrowDown"
							? Math.min(entries.length - 1, index + 1)
							: Math.max(0, index - 1);
			const next = entries[nextIndex];
			if (next) focusPath(next.entry.path);
			return;
		}
		if (event.key === "ArrowRight" && entry.kind === "directory") {
			event.preventDefault();
			if (!expanded.has(entry.path)) {
				onExpandDirectory(entry.path);
				return;
			}
			const child = entries[index + 1];
			if (child?.parentPath === entry.path) focusPath(child.entry.path);
			return;
		}
		if (event.key === "ArrowLeft") {
			if (entry.kind === "directory" && expanded.has(entry.path)) {
				event.preventDefault();
				onCollapseDirectory(entry.path);
				return;
			}
			if (parentPath.length > 0) {
				event.preventDefault();
				focusPath(parentPath);
			}
			return;
		}
		if (event.key.length === 1 && event.key !== " " && !event.altKey && !event.ctrlKey && !event.metaKey) {
			event.preventDefault();
			const next = advanceTreeTypeahead(typeaheadRef.current, event.key, entries, index, Date.now());
			typeaheadRef.current = next.state;
			if (next.path !== null) focusPath(next.path);
			return;
		}
		if (event.key === "Enter" || event.key === " ") {
			event.preventDefault();
			activateEntry(entry, event.key === "Enter");
		}
	};

	const renderExplorerRow = (row: WorkspaceExplorerRow): ReactNode => {
		if (row.kind !== "entry") {
			return <TreeMessageRow row={row} onRetryDirectory={onRetryDirectory} />;
		}
		const { entry, depth } = row;
		const directoryOpen = entry.kind === "directory" && expanded.has(entry.path);
		const directoryState = entry.kind === "directory" ? directories.get(entry.path) : undefined;
		const fileStatus = entry.kind === "file" ? statusByPath.get(entry.path) : undefined;
		const directoryChanges = entry.kind === "directory" ? changesByDirectory.get(entry.path) : undefined;
		return (
			<EntryContextMenu
				entry={entry}
				onCopyPath={onCopyPath}
				onInsertReference={onInsertReference}
				onRevealEntry={onRevealEntry}
			>
				<button
					ref={(node) => {
						if (node) rowRefs.current.set(entry.path, node);
						else rowRefs.current.delete(entry.path);
					}}
					type="button"
					role="treeitem"
					aria-level={depth + 1}
					aria-expanded={entry.kind === "directory" ? directoryOpen : undefined}
					aria-selected={entry.kind === "file" ? selectedPath === entry.path : undefined}
					aria-disabled={entry.kind === "unavailable" || undefined}
					tabIndex={activePath === entry.path ? 0 : -1}
					title={entry.path}
					style={{ paddingLeft: `${6 + depth * 16}px` }}
					onFocus={() => setActivePath(entry.path)}
					onClick={() => activateEntry(entry)}
					onDoubleClick={() => {
						if (entry.kind === "file") onSelectFile(entry.path, true);
					}}
					onKeyDown={(event) => handleEntryKeyDown(event, entry, row.parentPath)}
					className={cn(
						"group/tree-row flex h-7 w-full min-w-0 items-center gap-1 rounded-control pr-2 text-left text-xs outline-none transition-colors",
						selectedPath === entry.path
							? "bg-surface-hover text-text-primary"
							: "text-text-primary hover:bg-surface-hover/70",
						entry.kind === "unavailable" && "text-text-muted/55",
						"focus-visible:bg-surface-hover",
					)}
				>
					<span className="grid size-4 shrink-0 place-items-center text-text-muted">
						{entry.kind === "directory" ? (
							directoryState?.loading ? (
								<LoadingTransition label={t("explorer.loadingFolder")} size="xs" className="size-4 min-h-0" />
							) : (
								<ChevronRight
									className={cn(
										"size-3 transition-transform motion-reduce:transition-none",
										directoryOpen && "rotate-90",
									)}
									aria-hidden="true"
								/>
							)
						) : null}
					</span>
					<span className="relative grid size-4 shrink-0 place-items-center">
						{entry.kind === "directory" ? (
							directoryOpen ? (
								<FolderOpen className="size-4 text-text-muted" aria-hidden="true" />
							) : (
								<Folder className="size-4 text-text-muted" aria-hidden="true" />
							)
						) : entry.kind === "file" ? (
							<MaterialFileIcon path={entry.path} className="size-4 shrink-0" />
						) : (
							<FileWarning className="size-3.5 text-warning" aria-hidden="true" />
						)}
					</span>
					<span className="min-w-0 flex-1 truncate">{entry.name}</span>
					{entry.symbolicLink && <Link2 className="size-3 shrink-0 text-text-muted/60" aria-hidden="true" />}
					{directoryChanges !== undefined && directoryChanges > 0 && (
						<span className="min-w-4 shrink-0 rounded-full bg-accent-muted px-1 text-center font-mono text-xs text-accent tabular-nums">
							{directoryChanges}
						</span>
					)}
					{fileStatus !== undefined && (
						<span
							role="img"
							className={cn("w-3 shrink-0 text-right font-mono text-xs font-semibold", gitStatusClass(fileStatus))}
							aria-label={t(`explorer.gitStatus.${fileStatus}`)}
						>
							{gitStatusLabel(fileStatus)}
						</span>
					)}
				</button>
			</EntryContextMenu>
		);
	};

	return (
		<div ref={scrollRef} role="tree" aria-label={t("explorer.treeLabel")} className="min-h-0 flex-1 overflow-auto p-1">
			<div className="relative min-w-full" style={{ height: virtualizer.getTotalSize() }}>
				{virtualizer.getVirtualItems().map((virtualRow) => {
					const row = rows[virtualRow.index];
					if (row === undefined) return null;
					return (
						<div
							key={virtualRow.key}
							data-index={virtualRow.index}
							ref={virtualizer.measureElement}
							className="absolute top-0 left-0 w-full"
							style={{ transform: `translateY(${virtualRow.start}px)` }}
						>
							{renderExplorerRow(row)}
						</div>
					);
				})}
			</div>
		</div>
	);
}

/** Repeated characters cycle matching names; a pause starts a fresh prefix search. */
function advanceTreeTypeahead(
	previous: { query: string; updatedAt: number },
	key: string,
	entries: ReturnType<typeof entryRows>,
	index: number,
	now: number,
) {
	const normalizedKey = key.toLocaleLowerCase();
	const query =
		now - previous.updatedAt > TYPEAHEAD_RESET_MS
			? normalizedKey
			: previous.query.length > 0 && [...previous.query].every((character) => character === normalizedKey)
				? normalizedKey
				: `${previous.query}${normalizedKey}`;
	let path: string | null = null;
	for (let offset = 1; offset <= entries.length; offset += 1) {
		const candidate = entries[(index + offset) % entries.length];
		if (candidate?.entry.name.toLocaleLowerCase().startsWith(query)) {
			path = candidate.entry.path;
			break;
		}
	}
	return { state: { query, updatedAt: now }, path };
}
