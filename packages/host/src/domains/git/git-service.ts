import type {
	GitChangedFile,
	GitGraph,
	GitGraphCommit,
	GitGraphRef,
	GitGraphRefKind,
	GitStatus,
} from "@ling/contracts/git";
import { PROJECT_FILE_INDEX_MAX_ITEMS, PROJECT_FILE_INDEX_MAX_TOTAL_CHARS } from "@ling/contracts/project";
import { createReviewFileIdentity, type ReviewSnapshotFile } from "@ling/core/change-review/change-review";
import { createGitOutputBudget, type GitOutputBudget, readBoundedGitOutput } from "./git-output-budget";
import {
	assertGitPath,
	type BatchedDiffEntry,
	type GitDiffStat,
	type GitStatusFile,
	mapStatusFilesToChangedFiles,
	parseBatchedDiff,
	parseDiffNumstat,
	parseRawDiffWithNumstat,
} from "./git-output-parsers";
import {
	appendProjectPathspec,
	createGitClient,
	type GitProjectScope,
	literalPathspec,
	resolveGitProjectScope,
	scopedDiffArgs,
	toProjectPath,
	toRepositoryPath,
} from "./git-repository";

/** Max paths per hash-object invocation; 256 covers batched staging of small changes, more would overflow argv. */
const MAX_HASH_OBJECT_PATHS = 256;
/** Total byte limit for hash-object arguments; 24KiB stays below common OS ARG_MAX safety margins. */
const MAX_HASH_OBJECT_ARGUMENT_BYTES = 24 * 1024;
/** Git diff output byte limit (64MiB); oversized output is truncated/rejected so giant binary diffs cannot crush IPC. */
const MAX_GIT_DIFF_OUTPUT_BYTES = 64 * 1024 * 1024;
/** Byte ceiling for a blob read back out of Git (16MiB); a picture past that is not worth decoding to compare. */
const MAX_GIT_BLOB_BYTES = 16 * 1024 * 1024;
/** Max commit-graph nodes; 256 covers a branch overview, more makes the UI graph unreadable and serialization heavy. */
const MAX_GIT_GRAPH_COMMITS = 256;
/** Commit-graph raw output byte limit (4MiB). */
const MAX_GIT_GRAPH_OUTPUT_BYTES = 4 * 1024 * 1024;
/** Branch/upstream metadata is one bounded ref record plus one numeric commit count. */
const MAX_GIT_COMPARISON_OUTPUT_BYTES = 64 * 1024;
/** Per-commit text field char limit; 8Ki truncates oversized subject/body so abnormal commit messages cannot bloat the UI. */
const MAX_GIT_GRAPH_TEXT_CHARS = 8 * 1024;
/** Status is frequent and path-heavy; keep it well below the general Git command ceiling. */
const MAX_GIT_STATUS_OUTPUT_BYTES = 16 * 1024 * 1024;

interface GitStatusSnapshot {
	branch: string | null;
	files: GitStatusFile[];
	ahead: number;
	behind: number;
}

function parseStatusTracking(header: string): { ahead: number; behind: number } {
	const summary = / \[([^\]]+)\]$/.exec(header)?.[1];
	let ahead = 0;
	let behind = 0;
	if (!summary) return { ahead, behind };
	for (const field of summary.split(", ")) {
		const match = /^(ahead|behind) (\d+)$/.exec(field);
		if (!match) continue;
		const count = Number(match[2]);
		if (!Number.isSafeInteger(count) || count < 0) throw new Error("Invalid git status tracking summary");
		if (match[1] === "ahead") ahead = count;
		else behind = count;
	}
	return { ahead, behind };
}

function parseStatusBranch(header: string): string | null {
	if (!header.startsWith("## ")) throw new Error("Invalid git status branch header");
	const value = header.slice(3);
	if (value === "HEAD (no branch)") return null;
	const initial = value.match(/^(?:No commits yet|Initial commit) on (.+)$/);
	if (initial) return initial[1] ?? null;
	const tracking = value.indexOf("...");
	const summary = value.indexOf(" [");
	const end = tracking === -1 ? (summary === -1 ? value.length : summary) : tracking;
	return value.slice(0, end) || null;
}

/** `-z` reverses rename/copy fields to `target\0source\0` and leaves path bytes
 * unquoted. Parsing the NUL records directly avoids simple-git's line-oriented rename
 * parser corrupting paths that contain tabs, newlines, quotes, or non-ASCII text. */
function parseStatusPorcelainV1(output: string): GitStatusSnapshot {
	const records = output.split("\0");
	const header = records.shift();
	if (!header) throw new Error("Missing git status branch header");
	const files: GitStatusFile[] = [];
	let pathChars = 0;
	for (let index = 0; index < records.length; index += 1) {
		const record = records[index];
		if (!record) continue;
		if (record.length < 4 || record[2] !== " ") throw new Error("Invalid git status record");
		const statusIndex = record[0] ?? " ";
		const workingDir = record[1] ?? " ";
		const path = record.slice(3);
		assertGitPath(path);
		pathChars += path.length;
		const file: GitStatusFile = { path, index: statusIndex, working_dir: workingDir };
		if (statusIndex === "R" || statusIndex === "C" || workingDir === "R" || workingDir === "C") {
			const from = records[index + 1];
			if (!from) throw new Error("Missing git rename source path");
			assertGitPath(from);
			pathChars += from.length;
			file.from = from;
			index += 1;
		}
		if (files.length >= PROJECT_FILE_INDEX_MAX_ITEMS || pathChars > PROJECT_FILE_INDEX_MAX_TOTAL_CHARS) {
			throw new Error("Git status exceeds the project file-index limit");
		}
		files.push(file);
	}
	return { branch: parseStatusBranch(header), files, ...parseStatusTracking(header) };
}

function replaceStatusCode(value: string, from: "R" | "C", to: string): string {
	return value === from ? to : value;
}

/** Porcelain paths are always repository-root-relative, even when Git was started in
 * a nested project. Keep the IPC contract project-relative and reduce a rename that
 * crosses the project boundary to the side the project actually owns. */
function mapStatusFilesToProject(scope: GitProjectScope, files: readonly GitStatusFile[]): GitStatusFile[] {
	const scoped: GitStatusFile[] = [];
	for (const file of files) {
		const path = toProjectPath(scope, file.path);
		const from = file.from === undefined ? null : toProjectPath(scope, file.from);
		if (path !== null) {
			const mapped: GitStatusFile = {
				path,
				index: file.index,
				working_dir: file.working_dir,
			};
			if (from !== null) {
				mapped.from = from;
			} else if (file.from !== undefined) {
				// A rename/copy entering the project is an addition within this project's scope.
				mapped.index = replaceStatusCode(replaceStatusCode(mapped.index, "R", "A"), "C", "A");
				mapped.working_dir = replaceStatusCode(replaceStatusCode(mapped.working_dir, "R", "A"), "C", "A");
			}
			scoped.push(mapped);
			continue;
		}
		if (from === null) continue;
		const indexRename = file.index === "R";
		const worktreeRename = file.working_dir === "R";
		if (!indexRename && !worktreeRename) continue;
		// A rename leaving the project is a deletion here. Copy sources remain untouched.
		scoped.push({
			path: from,
			index: indexRename ? "D" : " ",
			working_dir: worktreeRename ? "D" : " ",
		});
	}
	return scoped;
}

function statusArgs(scope: GitProjectScope): string[] {
	const args = ["status", "--porcelain=v1", "-z", "--branch", "--untracked-files=all"];
	appendProjectPathspec(args, scope);
	return args;
}

async function getProjectStatusSnapshot(scope: GitProjectScope, signal?: AbortSignal): Promise<GitStatusSnapshot> {
	const budget = createGitOutputBudget(MAX_GIT_STATUS_OUTPUT_BYTES);
	const status = parseStatusPorcelainV1(await rawWithGitOutputBudget(scope, statusArgs(scope), budget, signal));
	return { ...status, files: mapStatusFilesToProject(scope, status.files) };
}

function mergeDiffStats(...maps: ReadonlyMap<string, GitDiffStat>[]): Map<string, GitDiffStat> {
	const merged = new Map<string, GitDiffStat>();
	for (const map of maps) {
		for (const [path, stat] of map) {
			const current = merged.get(path) ?? { additions: 0, deletions: 0 };
			merged.set(path, {
				additions: current.additions + stat.additions,
				deletions: current.deletions + stat.deletions,
			});
		}
	}
	return merged;
}

/** Project directories need not be Git repositories; the renderer hides Git controls in that state. */
export async function getGitStatus(cwd: string, signal?: AbortSignal): Promise<GitStatus> {
	const scope = await resolveGitProjectScope(cwd, signal);
	if (scope === null) {
		return {
			isRepository: false,
			currentBranch: null,
			detachedHeadSha: null,
			changedFiles: 0,
			ahead: 0,
			behind: 0,
			hasRemote: false,
		};
	}
	const projectStatus = await getProjectStatusSnapshot(scope, signal);
	const remoteBudget = createGitOutputBudget(64 * 1024);
	const remotes = await rawWithGitOutputBudget(scope, ["remote"], remoteBudget, signal);
	// Porcelain status identifies both attached and unborn branches without resolving a commit.
	// Only detached HEAD requires an object lookup for its display label.
	const detachedHeadSha =
		projectStatus.branch === null ? (await scope.repo.revparse(["--short", "HEAD"])).trim() : null;
	return {
		isRepository: true,
		currentBranch: projectStatus.branch,
		detachedHeadSha,
		changedFiles: projectStatus.files.length,
		ahead: projectStatus.ahead,
		behind: projectStatus.behind,
		hasRemote: remotes.trim().length > 0,
	};
}

function parseGitObjectId(value: string, label: string): string {
	if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) throw new Error(`Invalid Git graph ${label}`);
	return value;
}

function parseGitGraphText(value: string, label: string): string {
	if (value.length > MAX_GIT_GRAPH_TEXT_CHARS || value.includes("\0") || value.includes("\n")) {
		throw new Error(`Invalid Git graph ${label}`);
	}
	return value;
}

function parseGitGraphCommits(output: string): GitGraphCommit[] {
	if (output.length === 0) return [];
	const commits: GitGraphCommit[] = [];
	for (const rawLine of output.split("\n")) {
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		if (line.length === 0) continue;
		const fields = line.split("\0");
		if (fields.length !== 5) throw new Error("Invalid Git graph commit record");
		const [shaRaw, parentsRaw, authorRaw, authoredAtRaw, subjectRaw] = fields;
		if (
			shaRaw === undefined ||
			parentsRaw === undefined ||
			authorRaw === undefined ||
			authoredAtRaw === undefined ||
			subjectRaw === undefined
		) {
			throw new Error("Invalid Git graph commit record");
		}
		const authoredAtSeconds = Number(authoredAtRaw);
		if (!Number.isSafeInteger(authoredAtSeconds) || authoredAtSeconds < 0) {
			throw new Error("Invalid Git graph author time");
		}
		const authoredAt = authoredAtSeconds * 1_000;
		if (!Number.isSafeInteger(authoredAt)) throw new Error("Invalid Git graph author time");
		commits.push({
			sha: parseGitObjectId(shaRaw, "commit"),
			parents: parentsRaw.length === 0 ? [] : parentsRaw.split(" ").map((parent) => parseGitObjectId(parent, "parent")),
			author: parseGitGraphText(authorRaw, "author"),
			authoredAt,
			subject: parseGitGraphText(subjectRaw, "subject"),
		});
	}
	return commits;
}

function gitGraphRefKind(fullName: string): { kind: GitGraphRefKind; name: string } {
	const prefixes = [
		["refs/heads/", "local"],
		["refs/remotes/", "remote"],
		["refs/tags/", "tag"],
	] as const;
	for (const [prefix, kind] of prefixes) {
		if (!fullName.startsWith(prefix)) continue;
		const name = fullName.slice(prefix.length);
		if (name.length === 0) break;
		return { kind, name };
	}
	throw new Error("Invalid Git graph ref name");
}

function parseGitGraphRefs(output: string): GitGraphRef[] {
	if (output.length === 0) return [];
	const refs: GitGraphRef[] = [];
	for (const rawLine of output.split("\n")) {
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		if (line.length === 0) continue;
		const fields = line.split("\0");
		if (fields.length !== 6) throw new Error("Invalid Git graph ref record");
		const [objectRaw, objectType, peeledRaw, peeledType, fullNameRaw, symbolicTarget] = fields;
		if (
			objectRaw === undefined ||
			objectType === undefined ||
			peeledRaw === undefined ||
			peeledType === undefined ||
			fullNameRaw === undefined ||
			symbolicTarget === undefined
		) {
			throw new Error("Invalid Git graph ref record");
		}
		// `origin/HEAD` and similar aliases add no topology and duplicate their target label.
		if (symbolicTarget.length > 0) continue;
		const commitRaw = objectType === "commit" ? objectRaw : peeledType === "commit" ? peeledRaw : null;
		if (commitRaw === null) continue;
		const fullName = parseGitGraphText(fullNameRaw, "ref");
		const { kind, name } = gitGraphRefKind(fullName);
		refs.push({
			name: parseGitGraphText(name, "ref"),
			fullName,
			kind,
			commit: parseGitObjectId(commitRaw, "ref target"),
		});
	}
	const kindOrder: Record<GitGraphRefKind, number> = { local: 0, remote: 1, tag: 2 };
	return refs.sort(
		(left, right) => kindOrder[left.kind] - kindOrder[right.kind] || left.name.localeCompare(right.name),
	);
}

export async function getGitGraph(cwd: string, signal?: AbortSignal): Promise<GitGraph> {
	const scope = await resolveGitProjectScope(cwd, signal);
	if (scope === null) throw new Error("Git graph requires a repository");
	const resolvedHead = await resolveHeadSha(scope.repo);
	const headSha = resolvedHead === null ? null : parseGitObjectId(resolvedHead, "HEAD");
	const currentBranchRaw =
		headSha === null
			? (await scope.repo.raw(["symbolic-ref", "--short", "HEAD"])).trim()
			: (await scope.repo.revparse(["--abbrev-ref", "HEAD"])).trim();
	const currentBranch = currentBranchRaw === "HEAD" ? null : parseGitGraphText(currentBranchRaw, "current branch");
	const budget = createGitOutputBudget(MAX_GIT_GRAPH_OUTPUT_BYTES);
	const historyArgs = [
		"log",
		`--max-count=${MAX_GIT_GRAPH_COMMITS + 1}`,
		"--date-order",
		"--no-show-signature",
		"--format=%H%x00%P%x00%an%x00%at%x00%s",
		...(headSha === null ? [] : ["HEAD"]),
		"--branches",
		"--remotes",
		"--tags",
	];
	const commits = parseGitGraphCommits(await rawWithGitOutputBudget(scope, historyArgs, budget, signal));
	const refs = parseGitGraphRefs(
		await rawWithGitOutputBudget(
			scope,
			[
				"for-each-ref",
				"--format=%(objectname)%00%(objecttype)%00%(*objectname)%00%(*objecttype)%00%(refname)%00%(symref)",
				"refs/heads",
				"refs/remotes",
				"refs/tags",
			],
			budget,
			signal,
		),
	);
	return {
		headSha,
		currentBranch,
		commits: commits.slice(0, MAX_GIT_GRAPH_COMMITS),
		refs,
		truncated: commits.length > MAX_GIT_GRAPH_COMMITS,
	};
}

export async function getChangedFilesForScope(scope: GitProjectScope, signal?: AbortSignal): Promise<GitChangedFile[]> {
	const stagedArgs = scopedDiffArgs(scope, ["diff", "--no-ext-diff", "--numstat", "-z", "--cached"]);
	const unstagedArgs = scopedDiffArgs(scope, ["diff", "--no-ext-diff", "--numstat", "-z"]);
	appendProjectPathspec(stagedArgs, scope);
	appendProjectPathspec(unstagedArgs, scope);
	const status = await getProjectStatusSnapshot(scope, signal);
	const budget = createGitOutputBudget(MAX_GIT_DIFF_OUTPUT_BYTES);
	const stagedStats = parseDiffNumstat(await rawWithGitOutputBudget(scope, stagedArgs, budget, signal));
	const unstagedStats = parseDiffNumstat(await rawWithGitOutputBudget(scope, unstagedArgs, budget, signal));
	return mapStatusFilesToChangedFiles(status.files, mergeDiffStats(stagedStats, unstagedStats));
}

export async function getChangedFiles(cwd: string, signal?: AbortSignal): Promise<GitChangedFile[]> {
	const scope = await resolveGitProjectScope(cwd, signal);
	return scope === null ? [] : getChangedFilesForScope(scope, signal);
}

export async function getChangedFileDiff(
	cwd: string,
	path: string,
	signal?: AbortSignal,
	contextLines?: number,
): Promise<string> {
	assertGitPath(path);
	const scope = await resolveGitProjectScope(cwd, signal);
	if (scope === null) return "";
	const repositoryPath = toRepositoryPath(scope, path);
	const stagedArgs = scopedDiffArgs(scope, ["diff", "--no-ext-diff", "--cached"]);
	const unstagedArgs = scopedDiffArgs(scope, ["diff", "--no-ext-diff"]);
	appendStablePatchOptions(stagedArgs, contextLines);
	appendStablePatchOptions(unstagedArgs, contextLines);
	stagedArgs.push("--", literalPathspec(repositoryPath));
	unstagedArgs.push("--", literalPathspec(repositoryPath));
	const budget = createGitOutputBudget(MAX_GIT_DIFF_OUTPUT_BYTES);
	const staged = await rawWithGitOutputBudget(scope, stagedArgs, budget, signal);
	const unstaged = await rawWithGitOutputBudget(scope, unstagedArgs, budget, signal);
	if (staged.length === 0) return unstaged;
	if (unstaged.length === 0) return staged;
	return `${staged}\n${unstaged}`;
}

export interface GitReviewSnapshot {
	isRepository: boolean;
	gitRoot: string | null;
	headSha: string | null;
	branch: string | null;
	files: ReviewSnapshotFile[];
}

/**
 * A commit id is interpolated into git arguments, so it is constrained to the exact shape git
 * itself produces. Anything else is rejected rather than escaped: there is no legitimate commit
 * id containing a character outside this set.
 */
function assertCommitSha(sha: unknown): asserts sha is string {
	if (typeof sha !== "string" || !/^[0-9a-f]{7,64}$/.test(sha)) throw new Error("Invalid Git commit id");
}

/**
 * Files a single commit changed, read the way VS Code's git extension reads them: one
 * `diff-tree` call whose raw records carry the status and rename source while its numstat
 * records carry the line counts.
 */
export async function getCommitChangedFiles(cwd: string, sha: string, signal?: AbortSignal): Promise<GitChangedFile[]> {
	assertCommitSha(sha);
	const scope = await resolveGitProjectScope(cwd, signal);
	if (scope === null) return [];
	// `show` rather than `diff-tree`: it handles a root commit without extra flags, and with
	// --first-parent a merge reports the changes it introduced onto the branch it landed on
	// instead of reporting nothing at all, which is what diff-tree does for a merge by default.
	const args = [
		"show",
		"--format=",
		"-z",
		"--raw",
		"--numstat",
		"--no-ext-diff",
		"--diff-filter=ADMRT",
		"--first-parent",
		sha,
	];
	appendProjectPathspec(args, scope);
	const budget = createGitOutputBudget(MAX_GIT_DIFF_OUTPUT_BYTES);
	const files = parseRawDiffWithNumstat(await rawWithGitOutputBudget(scope, args, budget, signal));
	// diff-tree reports repository-relative paths; the rest of the app speaks project-relative.
	return files.flatMap((file) => {
		const path = toProjectPath(scope, file.path);
		if (path === null) return [];
		const from = file.from === undefined ? undefined : (toProjectPath(scope, file.from) ?? undefined);
		return [{ ...file, path, ...(from === undefined ? {} : { from }) }];
	});
}

/**
 * One file's patch within a commit. A root commit has no parent to diff against, so it is read
 * with `show`, which git treats as a diff against the empty tree.
 */
export async function getCommitFileDiff(
	cwd: string,
	sha: string,
	path: string,
	signal?: AbortSignal,
	contextLines?: number,
): Promise<string> {
	assertCommitSha(sha);
	assertGitPath(path);
	const scope = await resolveGitProjectScope(cwd, signal);
	if (scope === null) return "";
	const repositoryPath = toRepositoryPath(scope, path);
	const parents = (await createGitClient(scope.gitRoot).raw(["rev-list", "--parents", "-n", "1", sha]))
		.trim()
		.split(" ");
	const args =
		parents.length > 1 ? ["diff", "--no-ext-diff", `${sha}^`, sha] : ["show", "--no-ext-diff", "--format=", sha];
	appendStablePatchOptions(args, contextLines);
	args.push("--", literalPathspec(repositoryPath));
	const budget = createGitOutputBudget(MAX_GIT_DIFF_OUTPUT_BYTES);
	return rawWithGitOutputBudget(scope, args, budget, signal);
}

export async function getCanonicalGitRoot(cwd: string, signal?: AbortSignal): Promise<string | null> {
	const scope = await resolveGitProjectScope(cwd, signal);
	return scope === null ? null : scope.gitRoot;
}

async function resolveHeadSha(repo: ReturnType<typeof createGitClient>): Promise<string | null> {
	// `--quiet` represents an unborn HEAD as empty output without swallowing operational failures.
	const headSha = (await repo.revparse(["--verify", "--quiet", "HEAD"])).trim();
	return headSha.length === 0 ? null : headSha;
}

function appendStablePatchOptions(args: string[], contextLines?: number): void {
	args.push(
		"--no-textconv",
		"--no-color",
		"--submodule=short",
		"--src-prefix=a/",
		"--dst-prefix=b/",
		"--output-indicator-new=+",
		"--output-indicator-old=-",
		"--output-indicator-context= ",
	);
	if (contextLines !== undefined) args.push(`--unified=${String(contextLines)}`);
}

interface GitComparisonRef {
	fullName: string;
	shortName: string;
}

export interface GitUnpushedReviewSnapshot {
	comparisonRef: string;
	baseSha: string;
	headSha: string;
	commitCount: number;
	files: ReviewSnapshotFile[];
}

function parseGitCount(value: string, label: string): number {
	const normalized = value.trim();
	if (!/^\d+$/.test(normalized)) throw new Error(`Invalid Git ${label}`);
	const count = Number(normalized);
	if (!Number.isSafeInteger(count) || count < 0) throw new Error(`Invalid Git ${label}`);
	return count;
}

function parseComparisonRef(output: string): GitComparisonRef | null {
	const line = output.endsWith("\r\n") ? output.slice(0, -2) : output.endsWith("\n") ? output.slice(0, -1) : output;
	if (line.length === 0 || line === "\0") return null;
	const fields = line.split("\0");
	if (fields.length !== 2) throw new Error("Invalid Git upstream record");
	const [fullName, shortName] = fields;
	if (!fullName || !shortName || !fullName.startsWith("refs/") || fullName.includes("\n") || shortName.includes("\n")) {
		throw new Error("Invalid Git upstream ref");
	}
	return { fullName, shortName };
}

async function resolveComparisonRef(
	scope: GitProjectScope,
	branch: string | null,
	signal?: AbortSignal,
): Promise<GitComparisonRef | null> {
	if (branch === null) return null;
	const budget = createGitOutputBudget(MAX_GIT_COMPARISON_OUTPUT_BYTES);
	const output = await rawWithGitOutputBudget(
		scope,
		["for-each-ref", "--count=1", "--format=%(upstream)%00%(upstream:short)", `refs/heads/${branch}`],
		budget,
		signal,
	);
	return parseComparisonRef(output);
}

function mapRevisionFilesToProject(scope: GitProjectScope, files: readonly GitChangedFile[]): GitChangedFile[] {
	return files.flatMap((file) => {
		const path = toProjectPath(scope, file.path);
		const from = file.from === undefined ? null : toProjectPath(scope, file.from);
		if (path !== null) {
			if (from !== null) return [{ ...file, path, from }];
			if (file.from === undefined) return [{ ...file, path }];
			return [
				{
					path,
					status: "added" as const,
					...(file.additions === undefined ? {} : { additions: file.additions }),
					...(file.deletions === undefined ? {} : { deletions: file.deletions }),
				},
			];
		}
		if (from !== null && file.status === "renamed") {
			return [
				{
					path: from,
					status: "deleted" as const,
					additions: 0,
					...(file.deletions === undefined ? {} : { deletions: file.deletions }),
				},
			];
		}
		return [];
	});
}

/**
 * Captures committed work that exists on HEAD but not the branch's configured upstream.
 * This is deliberately local and never fetches: refresh compares immutable commits against
 * the current remote-tracking ref without turning review into a network mutation.
 */
export async function getGitUnpushedReviewSnapshot(
	cwd: string,
	signal?: AbortSignal,
): Promise<GitUnpushedReviewSnapshot | null> {
	const scope = await resolveGitProjectScope(cwd, signal);
	if (scope === null) return null;
	const status = await getProjectStatusSnapshot(scope, signal);
	const headSha = await resolveHeadSha(scope.repo);
	const comparison = await resolveComparisonRef(scope, status.branch, signal);
	if (headSha === null || comparison === null) return null;
	assertCommitSha(headSha);
	const commitArgs = ["rev-list", "--count", `${comparison.fullName}..${headSha}`];
	appendProjectPathspec(commitArgs, scope);
	const commitCount = parseGitCount(
		await rawWithGitOutputBudget(scope, commitArgs, createGitOutputBudget(MAX_GIT_COMPARISON_OUTPUT_BYTES), signal),
		"unpushed commit count",
	);
	if (commitCount === 0) {
		return { comparisonRef: comparison.shortName, baseSha: headSha, headSha, commitCount, files: [] };
	}
	const baseSha = (await scope.repo.raw(["merge-base", headSha, comparison.fullName])).trim();
	assertCommitSha(baseSha);
	const budget = createGitOutputBudget(MAX_GIT_DIFF_OUTPUT_BYTES);
	const rawArgs = [
		"diff",
		"--raw",
		"--numstat",
		"-z",
		"--no-ext-diff",
		"--find-copies",
		"--diff-filter=ACDMRT",
		baseSha,
		headSha,
	];
	appendProjectPathspec(rawArgs, scope);
	const changedFiles = mapRevisionFilesToProject(
		scope,
		parseRawDiffWithNumstat(await rawWithGitOutputBudget(scope, rawArgs, budget, signal)),
	);
	const patchArgs = scopedDiffArgs(scope, ["diff", "--no-ext-diff", "--find-copies", "--numstat", "-z", "--patch"]);
	appendStablePatchOptions(patchArgs);
	patchArgs.push(baseSha, headSha);
	appendProjectPathspec(patchArgs, scope);
	const patches = new Map(
		parseBatchedDiff(await rawWithGitOutputBudget(scope, patchArgs, budget, signal)).map((entry) => [
			entry.path,
			entry,
		]),
	);
	const files = changedFiles
		.map((file): ReviewSnapshotFile => {
			const patch = patches.get(file.path);
			if (patch === undefined) throw new Error(`Missing unpushed diff for ${file.path}`);
			const snapshot: ReviewSnapshotFile = { ...file, diff: patch.diff };
			snapshot.identity = createReviewFileIdentity(snapshot);
			return snapshot;
		})
		.sort((left, right) => left.path.localeCompare(right.path));
	return { comparisonRef: comparison.shortName, baseSha, headSha, commitCount, files };
}

/** One file's immutable patch between the captured upstream merge base and HEAD. */
export async function getGitRevisionFileDiff(
	cwd: string,
	baseSha: string,
	headSha: string,
	path: string,
	signal?: AbortSignal,
	contextLines?: number,
): Promise<string> {
	assertCommitSha(baseSha);
	assertCommitSha(headSha);
	assertGitPath(path);
	const scope = await resolveGitProjectScope(cwd, signal);
	if (scope === null) return "";
	const args = ["diff", "--no-ext-diff"];
	appendStablePatchOptions(args, contextLines);
	args.push(baseSha, headSha, "--", literalPathspec(toRepositoryPath(scope, path)));
	return rawWithGitOutputBudget(scope, args, createGitOutputBudget(MAX_GIT_DIFF_OUTPUT_BYTES), signal);
}

async function readGitBlobAtRevision(
	cwd: string,
	path: string,
	revision: string,
	signal?: AbortSignal,
): Promise<Buffer | null> {
	assertGitPath(path);
	if (revision !== "HEAD") assertCommitSha(revision);
	const scope = await resolveGitProjectScope(cwd, signal);
	if (scope === null) return null;
	// Resolve the symbolic HEAD once so the existence probe and byte read cannot
	// observe different commits when another Git operation advances the branch.
	const immutableRevision = revision === "HEAD" ? await resolveHeadSha(scope.repo) : revision;
	if (immutableRevision === null) return null;
	assertCommitSha(immutableRevision);
	const repositoryPath = toRepositoryPath(scope, path);
	const entry = await scope.repo.raw(["ls-tree", "-z", immutableRevision, "--", literalPathspec(repositoryPath)]);
	if (entry.length === 0) return null;
	const budget = createGitOutputBudget(MAX_GIT_BLOB_BYTES);
	const chunks: Buffer[] = [];
	await readBoundedGitOutput(
		budget,
		async ({ signal: commandSignal, record }) => {
			const repo = createGitClient(scope.gitRoot, commandSignal);
			repo.outputHandler((_command, stdout, stderr) => {
				stdout.on("data", (chunk: Buffer) => {
					record(chunk.byteLength);
					chunks.push(chunk);
				});
				stderr.on("data", (chunk: Buffer) => record(chunk.byteLength));
			});
			return repo.raw(["cat-file", "blob", `${immutableRevision}:${repositoryPath}`]);
		},
		signal,
	);
	return Buffer.concat(chunks);
}

/**
 * Reads a file's committed bytes. simple-git decodes stdout as text, which would corrupt a
 * picture, so the bytes are taken from the raw stream instead and its string result discarded.
 * An exact `ls-tree` probe distinguishes an absent path from a failed `cat-file`; only absence is
 * null because an added file has no committed version, while aborts and Git faults still surface.
 */
export function readGitBlobAtHead(cwd: string, path: string, signal?: AbortSignal): Promise<Buffer | null> {
	return readGitBlobAtRevision(cwd, path, "HEAD", signal);
}

/** Immutable blob lookup used by unpushed review; the caller supplies a validated commit id, not an arbitrary rev. */
export function readGitBlobAtCommit(
	cwd: string,
	sha: string,
	path: string,
	signal?: AbortSignal,
): Promise<Buffer | null> {
	return readGitBlobAtRevision(cwd, path, sha, signal);
}

async function rawWithGitOutputBudget(
	scope: GitProjectScope,
	args: string[],
	budget: GitOutputBudget,
	signal?: AbortSignal,
): Promise<string> {
	return readBoundedGitOutput(
		budget,
		async ({ signal, record }) => {
			const repo = createGitClient(scope.gitRoot, signal);
			const recordChunk = (chunk: Buffer | string): void => {
				record(typeof chunk === "string" ? Buffer.byteLength(chunk, "utf8") : chunk.byteLength);
			};
			repo.outputHandler((_command, stdout, stderr) => {
				stdout.on("data", recordChunk);
				stderr.on("data", recordChunk);
			});
			return repo.raw(args);
		},
		signal,
	);
}

async function getBatchedDiff(
	scope: GitProjectScope,
	cached: boolean,
	budget: GitOutputBudget,
	signal?: AbortSignal,
): Promise<BatchedDiffEntry[]> {
	const args = scopedDiffArgs(scope, ["diff", "--no-ext-diff", "--find-copies", "--numstat", "-z", "--patch"]);
	appendStablePatchOptions(args);
	if (cached) args.push("--cached");
	appendProjectPathspec(args, scope);
	return parseBatchedDiff(await rawWithGitOutputBudget(scope, args, budget, signal));
}

function mergeBatchedDiff(
	aggregate: { stats: Map<string, GitDiffStat>; diffs: Map<string, string> },
	batch: readonly BatchedDiffEntry[],
): void {
	for (const entry of batch) {
		const current = aggregate.stats.get(entry.path) ?? { additions: 0, deletions: 0 };
		aggregate.stats.set(entry.path, {
			additions: current.additions + entry.additions,
			deletions: current.deletions + entry.deletions,
		});
		if (entry.diff.length === 0) continue;
		const currentDiff = aggregate.diffs.get(entry.path);
		aggregate.diffs.set(
			entry.path,
			currentDiff === undefined || currentDiff.length === 0 ? entry.diff : `${currentDiff}\n${entry.diff}`,
		);
	}
}

function batchHashObjectPaths(paths: readonly string[]): string[][] {
	const batches: string[][] = [];
	let batch: string[] = [];
	let argumentBytes = 0;
	for (const path of paths) {
		const pathBytes = Buffer.byteLength(path, "utf8") + 1;
		if (
			batch.length > 0 &&
			(batch.length >= MAX_HASH_OBJECT_PATHS || argumentBytes + pathBytes > MAX_HASH_OBJECT_ARGUMENT_BYTES)
		) {
			batches.push(batch);
			batch = [];
			argumentBytes = 0;
		}
		batch.push(path);
		argumentBytes += pathBytes;
	}
	if (batch.length > 0) batches.push(batch);
	return batches;
}

async function getUntrackedBlobIdentities(
	scope: GitProjectScope,
	paths: readonly string[],
): Promise<Map<string, string>> {
	const identities = new Map<string, string>();
	for (const batch of batchHashObjectPaths(paths)) {
		const repositoryPaths = batch.map((path) => toRepositoryPath(scope, path));
		const output = await scope.repo.raw(["hash-object", "--no-filters", "--", ...repositoryPaths]);
		const hashes = output.trim().length === 0 ? [] : output.trim().split(/\r?\n/);
		if (hashes.length !== batch.length || hashes.some((hash) => !/^[a-f0-9]{40,64}$/.test(hash))) {
			throw new Error("Invalid git hash-object output");
		}
		for (const [index, path] of batch.entries()) {
			const hash = hashes[index];
			if (hash === undefined) throw new Error("Missing git hash-object identity");
			identities.set(path, hash);
		}
	}
	return identities;
}

export async function getGitReviewSnapshot(cwd: string, signal?: AbortSignal): Promise<GitReviewSnapshot> {
	const scope = await resolveGitProjectScope(cwd, signal);
	if (scope === null) return { isRepository: false, gitRoot: null, headSha: null, branch: null, files: [] };
	const status = await getProjectStatusSnapshot(scope, signal);
	const headSha = await resolveHeadSha(scope.repo);
	const budget = createGitOutputBudget(MAX_GIT_DIFF_OUTPUT_BYTES);
	const aggregate = { stats: new Map<string, GitDiffStat>(), diffs: new Map<string, string>() };
	mergeBatchedDiff(aggregate, await getBatchedDiff(scope, true, budget, signal));
	mergeBatchedDiff(aggregate, await getBatchedDiff(scope, false, budget, signal));
	const { stats, diffs } = aggregate;
	const statusFiles = mapStatusFilesToChangedFiles(status.files, stats);
	const untrackedBlobIdentities = await getUntrackedBlobIdentities(
		scope,
		statusFiles.filter((file) => file.status === "untracked").map((file) => file.path),
	);
	const changedFiles = statusFiles.map((file): ReviewSnapshotFile => {
		const snapshotFile: ReviewSnapshotFile = { ...file, diff: diffs.get(file.path) ?? "" };
		const contentIdentity = file.status === "untracked" ? untrackedBlobIdentities.get(file.path) : undefined;
		if (file.status === "untracked" && contentIdentity === undefined) {
			throw new Error(`Missing untracked content identity: ${file.path}`);
		}
		snapshotFile.identity = createReviewFileIdentity(snapshotFile, contentIdentity);
		return snapshotFile;
	});
	return {
		isRepository: true,
		gitRoot: scope.gitRoot,
		headSha,
		branch: status.branch,
		files: changedFiles,
	};
}

/** Local branches plus the currently checked-out one (null when detached). cheap to call
 * on dropdown open; safe to assume the caller already gated on `isRepository`. */
