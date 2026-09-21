import { type ProjectMentionItem, PROJECT_FILE_INDEX_MAX_TOTAL_CHARS } from "@ling/contracts/project";
import { listRepositoryFiles } from "@ling/host/domains/git/git-mutations";
import { getGitStatus } from "@ling/host/domains/git/git-service";
import { requestCapacityExceeded, requestCancelled, throwAggregateFailures } from "@ling/core/ling-error";
import { listProjectFiles as listWorkspaceFiles } from "@ling/host/domains/files/project-files";
import { LRUCache } from "lru-cache";

/**
 * Cache TTL for the @-mention file list. Enumerating the repo tree is pricey; repeat
 * completions within 10s reuse the result — longer than one completion interaction,
 * shorter than the acceptable delay of a new file staying invisible.
 */
const REPOSITORY_FILES_CACHE_TTL_MS = 10_000;
/** Each entry may retain a whole repository index plus an expiry timer. */
const REPOSITORY_FILES_CACHE_MAX_ENTRIES = 16;
/** Aggregate retained path/lowercase strings across all cached projects. */
const REPOSITORY_FILES_CACHE_MAX_WEIGHT_CHARS = 32 * 1024 * 1024;
/** One project index must stop before pathological deep/long paths dominate the process. */
const REPOSITORY_FILES_INDEX_MAX_DIRECTORIES = 50_000;
/**
 * Max items returned by the @-mention dropdown. 50 is enough for keyboard filtering;
 * more only adds rendering and main-process serialization — precise paths should come
 * from prefix filtering, not a longer list.
 */
const MAX_MENTION_RESULTS = 50;

interface MentionFileEntry {
	path: string;
	kind: "file" | "directory";
	lower: string;
	lowerBasename: string;
}

interface MentionFilesCacheEntry {
	files: Promise<MentionFileEntry[]>;
	/** Global preference the entry was built under; a mismatch invalidates it on next lookup. */
	respectGitignore: boolean;
}

function toMentionEntries(files: readonly string[]): MentionFileEntry[] {
	const entries: MentionFileEntry[] = [];
	const directories = new Set<string>();
	let filePathChars = 0;
	for (const path of files) {
		if (filePathChars + path.length > PROJECT_FILE_INDEX_MAX_TOTAL_CHARS) break;
		filePathChars += path.length;
		const lower = path.toLowerCase();
		entries.push({ path, kind: "file", lower, lowerBasename: lower.slice(lower.lastIndexOf("/") + 1) });
		for (let index = path.indexOf("/"); index !== -1; index = path.indexOf("/", index + 1)) {
			if (directories.size >= REPOSITORY_FILES_INDEX_MAX_DIRECTORIES) break;
			directories.add(path.slice(0, index));
		}
	}
	for (const path of directories) {
		const lower = path.toLowerCase();
		entries.push({ path, kind: "directory", lower, lowerBasename: lower.slice(lower.lastIndexOf("/") + 1) });
	}
	// Directories and files are interleaved by path: querying "src/c" ranks the src/core directory before its contents, not sunk after all files.
	entries.sort((a, b) => (a.lower < b.lower ? -1 : a.lower > b.lower ? 1 : 0));
	return entries;
}

function mentionEntriesWeightChars(entries: readonly MentionFileEntry[]): number {
	return entries.reduce(
		(total, entry) => total + entry.path.length + entry.lower.length + entry.lowerBasename.length,
		0,
	);
}

/** Basename-prefix matches first, then path substring matches; both buckets capped. */
export function filterMentionFiles(files: readonly MentionFileEntry[], query: string): ProjectMentionItem[] {
	const toItem = (entry: MentionFileEntry): ProjectMentionItem => ({ path: entry.path, kind: entry.kind });
	const needle = query.toLowerCase();
	if (needle === "") return files.slice(0, MAX_MENTION_RESULTS).map(toItem);
	const prefix: ProjectMentionItem[] = [];
	const substring: ProjectMentionItem[] = [];
	for (const entry of files) {
		if (entry.lowerBasename.startsWith(needle)) prefix.push(toItem(entry));
		else if (substring.length < MAX_MENTION_RESULTS && entry.lower.includes(needle)) substring.push(toItem(entry));
		if (prefix.length >= MAX_MENTION_RESULTS) break;
	}
	return [...prefix, ...substring].slice(0, MAX_MENTION_RESULTS);
}

export function createProjectMentionCache() {
	const pendingScans = new Set<Promise<MentionFileEntry[]>>();
	let disposed = false;
	let disposal: Promise<void> | null = null;

	// Active scans are admission slots, not evictable cache entries. TTL starts on settlement.
	const mentionFileScans = new Map<string, MentionFilesCacheEntry>();
	const mentionFilesCache = new LRUCache<string, MentionFilesCacheEntry>({
		max: REPOSITORY_FILES_CACHE_MAX_ENTRIES,
		maxSize: REPOSITORY_FILES_CACHE_MAX_WEIGHT_CHARS,
		ttl: REPOSITORY_FILES_CACHE_TTL_MS,
		ttlAutopurge: true,
		// Check each lookup against the clock instead of reusing a sampled timestamp.
		ttlResolution: 0,
	});

	function deleteMentionFilesCache(cwd: string): void {
		mentionFileScans.delete(cwd);
		mentionFilesCache.delete(cwd);
	}

	function clearMentionFilesCache(): void {
		mentionFileScans.clear();
		mentionFilesCache.clear();
	}

	function cachedMentionFiles(canonicalCwd: string, respectGitignore: boolean): Promise<MentionFileEntry[]> {
		if (disposed) return Promise.reject(requestCancelled("The project file index is shutting down."));
		const cached = mentionFileScans.get(canonicalCwd) ?? mentionFilesCache.get(canonicalCwd);
		if (cached && cached.respectGitignore === respectGitignore) {
			return cached.files;
		}
		// A preference flip invalidates in place: the setting is global, so the stale variant can
		// never be requested again and must not keep counting against the cache budgets.
		if (cached) deleteMentionFilesCache(canonicalCwd);
		while (mentionFileScans.size + mentionFilesCache.size >= REPOSITORY_FILES_CACHE_MAX_ENTRIES) {
			if (!mentionFilesCache.pop()) {
				throw requestCapacityExceeded(
					"projectMentionFileIndex",
					REPOSITORY_FILES_CACHE_MAX_ENTRIES,
					"The project file-index backlog is full. Wait for an active project scan to finish, then retry.",
				);
			}
		}
		let entry: MentionFilesCacheEntry;
		const files = (async () => {
			// Git repos always index through one `git ls-files` process; the setting only decides
			// whether .gitignore'd files (dist/, generated code) stay reachable. The directory walk
			// is the non-repo fallback only — it cannot honor .gitignore and enumerates build trees.
			const paths = (await getGitStatus(canonicalCwd)).isRepository
				? await listRepositoryFiles(canonicalCwd, respectGitignore)
				: await listWorkspaceFiles(canonicalCwd);
			return toMentionEntries(paths);
		})();
		const tracked = files.then(
			(result) => {
				if (mentionFileScans.get(canonicalCwd) === entry) {
					mentionFileScans.delete(canonicalCwd);
					mentionFilesCache.set(canonicalCwd, entry, {
						// lru-cache requires a positive size even for a confirmed empty index.
						size: Math.max(1, mentionEntriesWeightChars(result)),
					});
				}
				return result;
			},
			(error: unknown) => {
				if (mentionFileScans.get(canonicalCwd) === entry) mentionFileScans.delete(canonicalCwd);
				throw error;
			},
		);
		const observed = tracked.finally(() => pendingScans.delete(observed));
		pendingScans.add(observed);
		entry = { files: observed, respectGitignore };
		mentionFileScans.set(canonicalCwd, entry);
		return observed;
	}

	function dispose(): Promise<void> {
		if (disposal) return disposal;
		disposed = true;
		clearMentionFilesCache();
		disposal = Promise.allSettled([...pendingScans]).then((results) => {
			const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
			throwAggregateFailures(failures, "Project file scans failed during shutdown");
		});
		return disposal;
	}
	return { deleteMentionFilesCache, clearMentionFilesCache, cachedMentionFiles, dispose };
}

export type ProjectMentionCache = ReturnType<typeof createProjectMentionCache>;
