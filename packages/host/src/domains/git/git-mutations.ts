import type {
	CreateBranchRequest,
	GitChangedFile,
	GitChangedFileStatus,
	GitCommitResult,
	GitStatus,
	WorktreeBranchOption,
	WorktreeInfo,
} from "@ling/contracts/git";
import {
	GIT_BRANCH_MAX_CHARS,
	GIT_COMMIT_MESSAGE_MAX_CHARS,
	GIT_PATH_MAX_CHARS,
	GIT_REVISION_MAX_CHARS,
	GIT_SELECTED_PATHS_MAX_ITEMS,
	GIT_SELECTED_PATHS_TOTAL_MAX_CHARS,
} from "@ling/contracts/git";
import {
	PROJECT_FILE_INDEX_MAX_ITEMS,
	PROJECT_FILE_INDEX_MAX_TOTAL_CHARS,
	PROJECT_RELATIVE_PATH_MAX_CHARS,
} from "@ling/contracts/project";
import { errorMessage } from "@ling/contracts/ling-error";
import { hasControlCharacter } from "@ling/contracts/text-validation";
import { createLingError, throwIfOperationAborted } from "@ling/core/ling-error";
import { mkdir, realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { assertGitPath, parseWorktreePorcelain } from "./git-output-parsers";
import {
	assertAbsoluteGitPath,
	createGitClient,
	literalPathspec,
	resolveGitProjectScope,
	toRepositoryPath,
} from "./git-repository";
import { getChangedFiles, getChangedFilesForScope, getGitStatus } from "./git-service";

/** Expected selection and repository-state failures must survive the Host error boundary. */
function invalidGitRequest(message: string) {
	return createLingError({ code: "INVALID_REQUEST", category: "validation", message, retryable: false });
}

async function normalizeBranchName(repo: ReturnType<typeof createGitClient>, value: unknown): Promise<string> {
	if (typeof value !== "string") throw invalidGitRequest("Invalid branch name");
	const branch = value.trim();
	if (!branch || branch.length > GIT_BRANCH_MAX_CHARS || branch.startsWith("-") || hasControlCharacter(branch)) {
		throw invalidGitRequest("Invalid branch name");
	}
	let normalized: string;
	try {
		normalized = (await repo.raw(["check-ref-format", "--branch", branch])).trim();
	} catch {
		throw invalidGitRequest("Invalid branch name");
	}
	// Reject reflog shorthand such as `@{-1}`; the UI contract is a literal branch.
	if (normalized !== branch) throw invalidGitRequest("Invalid branch name");
	return branch;
}

function normalizeRevision(value: unknown): string {
	if (typeof value !== "string") throw invalidGitRequest("Invalid worktree start point");
	const revision = value.trim();
	if (
		!revision ||
		revision.length > GIT_REVISION_MAX_CHARS ||
		revision.startsWith("-") ||
		hasControlCharacter(revision)
	) {
		throw invalidGitRequest("Invalid worktree start point");
	}
	return revision;
}

/** Checks out an existing local branch. Fails fast — a dirty tree, a missing branch, or
 * any other git error throws, and the renderer surfaces the message rather than the
 * caller guessing at a fallback. */
export async function switchBranch(cwd: string, branch: string, signal?: AbortSignal): Promise<GitStatus> {
	const repo = createGitClient(cwd, signal);
	const normalized = await normalizeBranchName(repo, branch);
	const branches = await repo.branchLocal();
	if (!branches.all.includes(normalized)) throw invalidGitRequest(`Unknown local branch: ${normalized}`);
	await repo.checkout(normalized);
	return getGitStatus(cwd, signal);
}

export async function createBranch(request: CreateBranchRequest, signal?: AbortSignal): Promise<GitStatus> {
	const repo = createGitClient(request.cwd, signal);
	const branch = await normalizeBranchName(repo, request.branch);
	if (request.checkout) {
		await repo.checkoutLocalBranch(branch);
		return getGitStatus(request.cwd, signal);
	}
	await repo.branch([branch]);
	return getGitStatus(request.cwd, signal);
}

function normalizeCommitMessage(message: unknown): string {
	if (typeof message !== "string") throw invalidGitRequest("Invalid commit message");
	const trimmed = message.trim();
	if (!trimmed) throw invalidGitRequest("Commit message is required");
	if (message.length > GIT_COMMIT_MESSAGE_MAX_CHARS || message.includes("\0")) {
		throw invalidGitRequest("Invalid commit message");
	}
	return trimmed;
}

export async function commitAll(cwd: string, message: string, signal?: AbortSignal): Promise<GitCommitResult> {
	const normalized = normalizeCommitMessage(message);
	const scope = await resolveGitProjectScope(cwd, signal);
	if (scope === null) throw invalidGitRequest("No changes to commit");
	if ((await getChangedFilesForScope(scope, signal)).length === 0) throw invalidGitRequest("No changes to commit");
	if (scope.projectPrefix.length === 0) {
		await scope.repo.raw(["add", "--all"]);
		const result = await scope.repo.commit(normalized);
		return { commit: result.commit, branch: (await getGitStatus(cwd, signal)).currentBranch };
	}
	const projectPathspec = literalPathspec(scope.projectPrefix);
	await scope.repo.raw(["add", "--all", "--", projectPathspec]);
	await scope.repo.raw(["commit", "-m", normalized, "--", projectPathspec]);
	const commit = (await scope.repo.revparse(["HEAD"])).trim();
	return { commit, branch: (await getGitStatus(cwd, signal)).currentBranch };
}

function uniqueGitPaths(paths: readonly string[]): string[] {
	if (!Array.isArray(paths) || paths.length > GIT_SELECTED_PATHS_MAX_ITEMS) {
		throw invalidGitRequest("Invalid git path selection");
	}
	const unique: string[] = [];
	const seen = new Set<string>();
	let totalLength = 0;
	for (const path of paths) {
		assertGitPath(path);
		totalLength += path.length;
		if (totalLength > GIT_SELECTED_PATHS_TOTAL_MAX_CHARS) throw invalidGitRequest("Git path selection is too large");
		if (seen.has(path)) continue;
		seen.add(path);
		unique.push(path);
	}
	return unique;
}

export async function commitPaths(
	cwd: string,
	message: string,
	paths: readonly string[],
	signal?: AbortSignal,
): Promise<GitCommitResult> {
	const normalized = normalizeCommitMessage(message);
	const unique = uniqueGitPaths(paths);
	if (unique.length === 0) throw invalidGitRequest("No changes to commit");
	const scope = await resolveGitProjectScope(cwd, signal);
	if (scope === null) throw invalidGitRequest("No selected changes to commit");
	const changedPaths = new Set(
		(await getChangedFilesForScope(scope, signal)).flatMap((file) =>
			file.from ? [file.from, file.path] : [file.path],
		),
	);
	if (!unique.every((path) => changedPaths.has(path))) throw invalidGitRequest("No selected changes to commit");
	const pathspecs = unique.map((path) => literalPathspec(toRepositoryPath(scope, path)));
	await scope.repo.raw(["add", "--", ...pathspecs]);
	await scope.repo.raw(["commit", "-m", normalized, "--", ...pathspecs]);
	return {
		commit: (await scope.repo.revparse(["HEAD"])).trim(),
		branch: (await getGitStatus(cwd, signal)).currentBranch,
	};
}

export async function discardPaths(cwd: string, paths: readonly string[], signal?: AbortSignal): Promise<GitStatus> {
	const unique = uniqueGitPaths(paths);
	if (unique.length === 0) throw invalidGitRequest("No changes to discard");
	const scope = await resolveGitProjectScope(cwd, signal);
	if (scope === null) throw invalidGitRequest("No selected changes to discard");
	const selected = (await getChangedFilesForScope(scope, signal)).filter(
		(file) => unique.includes(file.path) || (file.from ? unique.includes(file.from) : false),
	);
	if (selected.length === 0) throw invalidGitRequest("No selected changes to discard");
	const untrackedPaths = selected.filter((file) => file.status === "untracked").map((file) => file.path);
	const trackedPaths = selected
		.filter((file) => file.status !== "untracked")
		.flatMap((file) => (file.from ? [file.from, file.path] : [file.path]));
	const trackedPathspecs = uniqueGitPaths(trackedPaths).map((path) => literalPathspec(toRepositoryPath(scope, path)));
	const untrackedPathspecs = uniqueGitPaths(untrackedPaths).map((path) =>
		literalPathspec(toRepositoryPath(scope, path)),
	);
	if (trackedPaths.length > 0) await scope.repo.raw(["restore", "--staged", "--worktree", "--", ...trackedPathspecs]);
	if (untrackedPaths.length > 0) await scope.repo.raw(["clean", "-f", "--", ...untrackedPathspecs]);
	return getGitStatus(cwd, signal);
}

export async function pushCurrentBranch(cwd: string, signal?: AbortSignal): Promise<GitStatus> {
	const status = await getGitStatus(cwd, signal);
	if (!status.currentBranch) throw invalidGitRequest("Cannot push a detached HEAD");
	await createGitClient(cwd, signal).push("origin", status.currentBranch, ["--set-upstream"]);
	return getGitStatus(cwd, signal);
}

function commitSubjectFor(files: readonly GitChangedFile[]): string {
	if (files.length === 0) return "Update project";
	const counts = files.reduce(
		(summary, file) => {
			summary[file.status] += 1;
			return summary;
		},
		{
			modified: 0,
			added: 0,
			deleted: 0,
			renamed: 0,
			copied: 0,
			untracked: 0,
			conflicted: 0,
		} satisfies Record<GitChangedFileStatus, number>,
	);
	const dominant = Object.entries(counts).sort(([, left], [, right]) => right - left)[0]?.[0] as
		GitChangedFileStatus | undefined;
	const label =
		dominant === "added" || dominant === "untracked"
			? "Add"
			: dominant === "deleted"
				? "Remove"
				: dominant === "renamed"
					? "Rename"
					: "Update";
	if (files.length === 1) return `${label} ${files[0]?.path ?? "project"}`;
	return `${label} ${files.length} files`;
}

export async function generateCommitMessage(cwd: string): Promise<string> {
	const files = await getChangedFiles(cwd);
	const subject = commitSubjectFor(files);
	const details = files
		.slice(0, 8)
		.map((file) => `- ${file.status}: ${file.from ? `${file.from} -> ` : ""}${file.path}`)
		.join("\n");
	if (!details) return subject;
	return `${subject}\n\n${details}`;
}

export async function listWorktrees(cwd: string, signal?: AbortSignal): Promise<WorktreeInfo[]> {
	const output = await createGitClient(cwd, signal).raw(["worktree", "list", "--porcelain"]);
	const worktrees = parseWorktreePorcelain(output);
	return Promise.all(
		worktrees.map(async (worktree) => ({
			...worktree,
			canonicalPath: await realpath(worktree.path),
		})),
	);
}

/** Recent local branches for Worktree creation, annotated when already checked out. */
export async function listWorktreeBranchOptions(cwd: string, signal?: AbortSignal): Promise<WorktreeBranchOption[]> {
	const repo = createGitClient(cwd, signal);
	const [output, worktreeOutput] = await Promise.all([
		repo.raw(["for-each-ref", "--count=40", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads"]),
		repo.raw(["worktree", "list", "--porcelain"]),
	]);
	const worktrees = parseWorktreePorcelain(worktreeOutput);
	const checkedOutPaths = new Map(
		worktrees.flatMap((worktree) => (worktree.branchName ? [[worktree.branchName, worktree.path] as const] : [])),
	);
	return output
		.split("\n")
		.map((name) => name.trim())
		.filter((name) => name.length > 0)
		.map((name) => ({ name, checkedOutPath: checkedOutPaths.get(name) ?? null }));
}

/** Tracked + untracked files, repo-relative with forward slashes — the completion corpus for
 * @-mentions. respectGitignore=true excludes .gitignore'd files; false keeps them reachable
 * (dist/, generated code) while still skipping node_modules, matching the non-repo walk's
 * omissions. Bounded: gigantic repos are cut at the cap, which a prefix query then narrows. */
export async function listRepositoryFiles(
	cwd: string,
	respectGitignore: boolean,
	signal?: AbortSignal,
): Promise<string[]> {
	assertAbsoluteGitPath(cwd, "git working directory");
	throwIfOperationAborted(signal);
	const controller = new AbortController();
	const combinedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
	throwIfOperationAborted(signal);

	const files: string[] = [];
	let filePathChars = 0;
	let outputBytes = 0;
	let pending = "";
	let discardingOversizedEntry = false;
	let reachedLimit = false;
	const decoder = new StringDecoder("utf8");
	// UTF-8 needs at most four bytes per decoded character. The extra path allowance
	// lets the parser observe and discard one oversized entry without retaining it.
	const maxOutputBytes = PROJECT_FILE_INDEX_MAX_TOTAL_CHARS * 4 + PROJECT_RELATIVE_PATH_MAX_CHARS * 4;
	const stopAtLimit = (): void => {
		if (reachedLimit) return;
		reachedLimit = true;
		controller.abort();
	};
	const acceptEntry = (entry: string): boolean => {
		if (entry.length === 0 || entry.length > PROJECT_RELATIVE_PATH_MAX_CHARS) return true;
		if (filePathChars + entry.length > PROJECT_FILE_INDEX_MAX_TOTAL_CHARS) {
			stopAtLimit();
			return false;
		}
		files.push(entry);
		filePathChars += entry.length;
		if (files.length >= PROJECT_FILE_INDEX_MAX_ITEMS) {
			stopAtLimit();
			return false;
		}
		return true;
	};
	const consume = (text: string): void => {
		let start = 0;
		while (!reachedLimit) {
			const separator = text.indexOf("\0", start);
			if (separator === -1) {
				if (!discardingOversizedEntry) {
					pending += text.slice(start);
					if (pending.length > PROJECT_RELATIVE_PATH_MAX_CHARS) {
						pending = "";
						discardingOversizedEntry = true;
					}
				}
				return;
			}
			if (discardingOversizedEntry) {
				discardingOversizedEntry = false;
				pending = "";
			} else {
				const entry = pending + text.slice(start, separator);
				pending = "";
				if (!acceptEntry(entry)) return;
			}
			start = separator + 1;
		}
	};
	const recordOutputBytes = (chunk: Buffer | string): boolean => {
		const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
		outputBytes += buffer.byteLength;
		if (outputBytes > maxOutputBytes) {
			stopAtLimit();
			return false;
		}
		return true;
	};
	const recordStdout = (chunk: Buffer | string): void => {
		if (!recordOutputBytes(chunk)) return;
		const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
		consume(decoder.write(buffer));
	};

	const repo = createGitClient(cwd, combinedSignal);
	repo.outputHandler((_command, stdout, stderr) => {
		stdout.on("data", recordStdout);
		stderr.on("data", recordOutputBytes);
	});
	try {
		const excludes = respectGitignore ? ["--exclude-standard"] : ["--exclude=node_modules/", "--exclude=.DS_Store"];
		await repo.raw(["ls-files", "-co", ...excludes, "-z"]);
		consume(decoder.end());
	} catch (error) {
		throwIfOperationAborted(signal);
		if (!reachedLimit) throw error;
	}
	return files;
}

export async function createWorktree(
	rootCwd: string,
	options: { path: string; branchName?: string; startPoint?: string },
	signal?: AbortSignal,
): Promise<WorktreeInfo> {
	if (!options || typeof options !== "object" || Array.isArray(options))
		throw invalidGitRequest("Invalid worktree options");
	assertAbsoluteGitPath(options.path, "worktree path", GIT_PATH_MAX_CHARS);
	if (Object.keys(options).some((key) => key !== "path" && key !== "branchName" && key !== "startPoint")) {
		throw invalidGitRequest("Invalid worktree options");
	}
	const args = ["worktree", "add"];
	const repo = createGitClient(rootCwd, signal);
	if (options.branchName !== undefined) args.push("-b", await normalizeBranchName(repo, options.branchName));
	await mkdir(dirname(options.path), { recursive: true });
	args.push("--", options.path);
	if (options.startPoint !== undefined) args.push(normalizeRevision(options.startPoint));
	await repo.raw(args);
	const canonicalPath = await realpath(options.path);
	const [created] = (await listWorktrees(rootCwd, signal)).filter(
		(worktree) => worktree.canonicalPath === canonicalPath,
	);
	if (!created) throw new Error(`Created worktree was not found: ${options.path}`);
	return created;
}

/**
 * Rolls back a worktree this call just created (transactional creation). The worktree —
 * and, when `branchName` was passed, its branch — are brand-new artifacts of the failed
 * call, so force-removal touches nothing pre-existing. Best-effort: failures are
 * reported to the caller's logger, never thrown over the original error.
 */
export async function destroyCreatedWorktree(
	rootCwd: string,
	options: { path: string; branchName?: string },
	signal?: AbortSignal,
): Promise<string[]> {
	assertAbsoluteGitPath(rootCwd, "git working directory");
	assertAbsoluteGitPath(options.path, "worktree path", GIT_PATH_MAX_CHARS);
	const repo = createGitClient(rootCwd, signal);
	const failures: string[] = [];
	try {
		await repo.raw(["worktree", "remove", "--force", "--", options.path]);
	} catch (error) {
		failures.push(`worktree ${options.path}: ${errorMessage(error)}`);
	}
	if (options.branchName !== undefined) {
		try {
			// Plain -d: refuses anything unmerged. A branch that gained no commits deletes
			// cleanly; anything else is left behind — a leaked branch beats a lost commit.
			await repo.raw(["branch", "-d", "--", await normalizeBranchName(repo, options.branchName)]);
		} catch (error) {
			failures.push(`branch ${options.branchName}: ${errorMessage(error)}`);
		}
	}
	return failures;
}

export async function removeWorktree(rootCwd: string, worktreePath: string, signal?: AbortSignal): Promise<void> {
	assertAbsoluteGitPath(rootCwd, "git working directory");
	assertAbsoluteGitPath(worktreePath, "worktree path", GIT_PATH_MAX_CHARS);
	const primary = await realpath(rootCwd);
	const target = await realpath(worktreePath);
	if (target === primary) throw invalidGitRequest("Cannot remove the primary worktree");
	await createGitClient(rootCwd, signal).raw(["worktree", "remove", "--", worktreePath]);
}
