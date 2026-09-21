import { useDomainApi } from "@renderer/lib/host-api-context";
import type { ProjectDirectoryEntry } from "@ling/contracts/project";
import { formatRequestError, isProjectDirectoryMissing } from "@renderer/lib/errors";
import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";

export interface WorkspaceExplorerNavigation {
	selectedPath: string | null;
	expanded: ReadonlySet<string>;
	query: string;
	scrollTop: number;
}
export const EMPTY_EXPLORER_NAVIGATION: WorkspaceExplorerNavigation = {
	selectedPath: null,
	expanded: new Set<string>(),
	query: "",
	scrollTop: 0,
};

export interface WorkspaceDirectoryState {
	entries: readonly ProjectDirectoryEntry[];
	truncated: boolean;
	loaded: boolean;
	loading: boolean;
	error: string | null;
	/** The folder is gone rather than unreadable; callers present the folder itself as deleted. */
	directoryMissing: boolean;
}

export type WorkspaceExplorerRow =
	| {
			kind: "entry";
			entry: ProjectDirectoryEntry;
			parentPath: string;
			depth: number;
	  }
	| {
			kind: "loading" | "empty" | "truncated";
			directoryPath: string;
			depth: number;
	  }
	| {
			kind: "error";
			directoryPath: string;
			depth: number;
			message: string;
	  };

/** Stable empty state for directories not yet requested; shared as the Map default so no per-path object is allocated. */
const EMPTY_DIRECTORY_STATE: WorkspaceDirectoryState = {
	entries: [],
	truncated: false,
	loaded: false,
	loading: false,
	error: null,
	directoryMissing: false,
};

/** Closed folders are reloadable filesystem cache, so retaining every folder ever visited
 * would be a history leak. Expanded folders are user-visible state and have their own cap. */
const MAX_RETAINED_DIRECTORY_STATES = 512;
const MAX_EXPANDED_DIRECTORIES = 256;

function isDescendantPath(candidate: string, parent: string): boolean {
	return parent.length === 0 ? candidate.length > 0 : candidate.startsWith(`${parent}/`);
}

function pruneDirectoryStates(
	directories: Map<string, WorkspaceDirectoryState>,
	expanded: ReadonlySet<string>,
): Map<string, WorkspaceDirectoryState> {
	if (directories.size <= MAX_RETAINED_DIRECTORY_STATES) return directories;
	for (const [path, state] of directories) {
		if (directories.size <= MAX_RETAINED_DIRECTORY_STATES) break;
		if (path.length === 0 || expanded.has(path) || state.loading) continue;
		directories.delete(path);
	}
	return directories;
}

function withDirectoryState(
	current: ReadonlyMap<string, WorkspaceDirectoryState>,
	path: string,
	state: WorkspaceDirectoryState,
	expanded: ReadonlySet<string>,
): Map<string, WorkspaceDirectoryState> {
	const next = new Map(current);
	// Refresh insertion order so pruning behaves as an LRU for closed folders.
	next.delete(path);
	next.set(path, state);
	return pruneDirectoryStates(next, expanded);
}

function expandDirectorySet(current: ReadonlySet<string>, path: string): Set<string> {
	const next = new Set(current);
	if (next.has(path)) return next;
	if (next.size >= MAX_EXPANDED_DIRECTORIES) {
		for (const candidate of next) {
			// Collapsing an ancestor would also hide the folder the user just opened.
			if (isDescendantPath(path, candidate)) continue;
			for (const entry of next) {
				if (entry === candidate || isDescendantPath(entry, candidate)) next.delete(entry);
			}
			break;
		}
	}
	if (next.size < MAX_EXPANDED_DIRECTORIES) next.add(path);
	return next;
}

function projectParentPath(path: string): string | null {
	const index = path.lastIndexOf("/");
	if (index === -1) return path.length === 0 ? null : "";
	return path.slice(0, index);
}

function projectVisibleRows(
	directories: ReadonlyMap<string, WorkspaceDirectoryState>,
	expanded: ReadonlySet<string>,
): WorkspaceExplorerRow[] {
	const root = directories.get("");
	if (!root?.loaded) return [];
	const rows: WorkspaceExplorerRow[] = [];

	const appendDirectory = (directoryPath: string, depth: number): void => {
		const state = directories.get(directoryPath);
		if (!state) return;
		for (const entry of state.entries) {
			rows.push({ kind: "entry", entry, parentPath: directoryPath, depth });
			if (entry.kind !== "directory" || !expanded.has(entry.path)) continue;
			const child = directories.get(entry.path);
			if (!child?.loaded) {
				if (child?.error) {
					rows.push({
						kind: "error",
						directoryPath: entry.path,
						depth: depth + 1,
						message: child.error,
					});
				} else {
					rows.push({ kind: "loading", directoryPath: entry.path, depth: depth + 1 });
				}
				continue;
			}
			if (child.error) {
				rows.push({
					kind: "error",
					directoryPath: entry.path,
					depth: depth + 1,
					message: child.error,
				});
			}
			if (child.entries.length === 0) {
				rows.push({ kind: "empty", directoryPath: entry.path, depth: depth + 1 });
			} else {
				appendDirectory(entry.path, depth + 1);
			}
			if (child.truncated) rows.push({ kind: "truncated", directoryPath: entry.path, depth: depth + 1 });
		}
		if (directoryPath === "" && state.truncated) {
			rows.push({ kind: "truncated", directoryPath, depth });
		}
	};

	appendDirectory("", 0);
	return rows;
}

export function useWorkspaceExplorer(
	cwd: string,
	open: boolean,
	expanded: ReadonlySet<string>,
	setExpanded: Dispatch<SetStateAction<ReadonlySet<string>>>,
) {
	const hostProjectApi = useDomainApi("project");

	const [directories, setDirectories] = useState<Map<string, WorkspaceDirectoryState>>(new Map());
	const mountedRef = useRef(true);
	const generationRef = useRef(0);
	const nextRequestIdRef = useRef(1);
	const requestIdsRef = useRef(new Map<string, number>());
	const directoriesRef = useRef(directories);
	const expandedRef = useRef(expanded);
	const openRef = useRef(open);
	directoriesRef.current = directories;
	expandedRef.current = expanded;
	openRef.current = open;

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
			generationRef.current += 1;
			// eslint-disable-next-line react-hooks/exhaustive-deps -- the cleanup deliberately reads the ref as it stands at teardown, not the value captured at setup
			requestIdsRef.current.clear();
		};
	}, []);

	const loadDirectory = useCallback(
		(path: string): void => {
			if (requestIdsRef.current.has(path)) return;
			const generation = generationRef.current;
			const requestId = nextRequestIdRef.current++;
			requestIdsRef.current.set(path, requestId);
			setDirectories((current) => {
				const previous = current.get(path) ?? EMPTY_DIRECTORY_STATE;
				return withDirectoryState(
					current,
					path,
					{ ...previous, loading: true, error: null, directoryMissing: false },
					expandedRef.current,
				);
			});
			void hostProjectApi
				.listDirectory({ cwd, path })
				.then((listing) => {
					if (
						!mountedRef.current ||
						generationRef.current !== generation ||
						requestIdsRef.current.get(path) !== requestId
					) {
						return;
					}
					requestIdsRef.current.delete(path);
					setDirectories((current) => {
						return withDirectoryState(
							current,
							path,
							{
								entries: listing.entries,
								truncated: listing.truncated,
								loaded: true,
								loading: false,
								error: null,
								directoryMissing: false,
							},
							expandedRef.current,
						);
					});
				})
				.catch((error: unknown) => {
					if (
						!mountedRef.current ||
						generationRef.current !== generation ||
						requestIdsRef.current.get(path) !== requestId
					) {
						return;
					}
					requestIdsRef.current.delete(path);
					setDirectories((current) => {
						const previous = current.get(path) ?? EMPTY_DIRECTORY_STATE;
						return withDirectoryState(
							current,
							path,
							{
								...previous,
								loading: false,
								error: formatRequestError(error),
								directoryMissing: isProjectDirectoryMissing(error),
							},
							expandedRef.current,
						);
					});
				});
		},
		[hostProjectApi, cwd],
	);

	useEffect(() => {
		generationRef.current += 1;
		requestIdsRef.current.clear();
		setDirectories(new Map());
		if (openRef.current) {
			loadDirectory("");
			for (const path of expandedRef.current) loadDirectory(path);
		}
	}, [loadDirectory]);

	useEffect(() => {
		if (!open) return;
		const root = directoriesRef.current.get("");
		if (!root?.loaded && !root?.loading && !requestIdsRef.current.has("")) loadDirectory("");
	}, [loadDirectory, open]);

	const releaseCollapsedDirectory = useCallback((path: string): void => {
		for (const candidate of requestIdsRef.current.keys()) {
			if (isDescendantPath(candidate, path)) requestIdsRef.current.delete(candidate);
		}
		setDirectories((current) => {
			const next = new Map(current);
			for (const candidate of next.keys()) {
				if (isDescendantPath(candidate, path)) next.delete(candidate);
			}
			return next;
		});
	}, []);

	const expandDirectory = useCallback(
		(path: string) => {
			if (expandedRef.current.has(path)) return;
			setExpanded((current) => expandDirectorySet(current, path));
			const state = directoriesRef.current.get(path);
			if (!state?.loaded && !state?.loading) loadDirectory(path);
		},
		[loadDirectory, setExpanded],
	);

	const collapseDirectory = useCallback(
		(path: string) => {
			if (!expandedRef.current.has(path)) return;
			setExpanded((current) => {
				const next = new Set(current);
				for (const candidate of next) {
					if (candidate === path || isDescendantPath(candidate, path)) next.delete(candidate);
				}
				return next;
			});
			releaseCollapsedDirectory(path);
		},
		[releaseCollapsedDirectory, setExpanded],
	);

	const toggleDirectory = useCallback(
		(path: string) => {
			if (expandedRef.current.has(path)) collapseDirectory(path);
			else expandDirectory(path);
		},
		[collapseDirectory, expandDirectory],
	);

	const collapseAll = useCallback(() => {
		setExpanded(new Set());
		// The root remains visible. Invalidating its pending read would leave loading=true forever.
		for (const path of requestIdsRef.current.keys()) if (path !== "") requestIdsRef.current.delete(path);
		setDirectories((current) => {
			const root = current.get("");
			return root === undefined ? new Map() : new Map([["", root]]);
		});
	}, [setExpanded]);

	const refresh = useCallback(() => {
		const paths = new Set(["", ...expandedRef.current]);
		for (const path of paths) loadDirectory(path);
	}, [loadDirectory]);

	const retryDirectory = useCallback((path: string) => loadDirectory(path), [loadDirectory]);
	const rows = useMemo(() => projectVisibleRows(directories, expanded), [directories, expanded]);
	const root = directories.get("") ?? EMPTY_DIRECTORY_STATE;

	return {
		directories,
		expanded,
		rows,
		root,
		toggleDirectory,
		expandDirectory,
		collapseDirectory,
		collapseAll,
		refresh,
		retryDirectory,
		parentPath: projectParentPath,
	};
}
